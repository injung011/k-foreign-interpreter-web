// Google Gemini 호출(무료 구간) — 브라우저에서 사용자의 Gemini API 키로 직접 호출.
// OpenAIClient와 같은 모양(check / transcribe / translate)이라 엔진이 그대로 씀.
//
// 무료 구간은 분당 요청 수 한도가 있어서, 한 문장마다 "받아 적기 + 번역"을 한 번의 요청으로 처리하고
// 번역 결과는 기억해 두었다가 translate()가 불리면 요청 없이 바로 돌려줌(요청 수를 절반으로).
import { t } from './i18n.js';
import { lang } from './langs.js';
import { OpenAIError } from './openai.js';
import { translateInstructions } from './situations.js';
import { toWav } from './wav.js';

// 2026-10 기준 무료 구간 모델(앞에서부터 시도, 없으면 다음)
export const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends OpenAIError {
  get userMessage() {
    const k = ['auth', 'rate', 'network', 'server', 'model', 'quota'].includes(this.kind) ? this.kind : 'bad';
    return t(`gm_${k}`, { e: this.message });
  }
}

async function classify(res) {
  let msg = '', status = '', retry = 0;
  try {
    const js = await res.json();
    msg = js?.error?.message || '';
    status = js?.error?.status || '';
    const ri = (js?.error?.details || []).find((d) => String(d['@type'] || '').includes('RetryInfo'));
    if (ri && ri.retryDelay) retry = parseFloat(ri.retryDelay) || 0;
  } catch (e) { msg = res.statusText; }
  const s = res.status, low = `${status} ${msg}`.toLowerCase();
  let err;
  if (low.includes('api_key_invalid') || low.includes('api key not valid') || s === 401 || s === 403) err = new GeminiError('auth', msg, s);
  else if (s === 429 || low.includes('resource_exhausted')) err = new GeminiError(low.includes('per day') || low.includes('perday') ? 'quota' : 'rate', msg, s);
  else if (s === 404 || (low.includes('model') && /not found|not supported/.test(low))) err = new GeminiError('model', msg, s);
  else if (s >= 500) err = new GeminiError('server', msg, s);
  else err = new GeminiError('bad', msg, s);
  err.retry = retry;
  return err;
}

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function textOf(js) {
  const parts = js?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
}

export class GeminiClient {
  constructor(key, base = GEMINI_BASE) {
    this.key = key;
    this.base = base.replace(/\/$/, '');
    this.model = null;
    this.noThinkCfg = false;
    this.cache = new Map(); // 받아 적은 문장 → 번역(같은 요청에서 받아 둔 것)
    this.free = true;       // 요금 표시 안 함
  }

  async _fetch(path, opts = {}, timeoutMs = 30000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(this.base + path, {
        ...opts, signal: ctl.signal,
        headers: { 'x-goog-api-key': this.key, ...(opts.headers || {}) },
      });
    } catch (e) {
      throw new GeminiError('network', e.name === 'AbortError' ? 'timeout' : String(e));
    } finally { clearTimeout(timer); }
    if (!res.ok) throw await classify(res);
    return res;
  }

  async check() {
    const res = await this._fetch('/models?pageSize=200', {}, 15000);
    const js = await res.json();
    return (js.models || []).length;
  }

  // 모델을 앞에서부터 시도. 분당 한도(429)면 알려 준 시간만큼(최대 20초) 기다렸다 한 번 더.
  async _generate(body) {
    const models = this.model ? [this.model] : GEMINI_MODELS;
    let last;
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const b = JSON.parse(JSON.stringify(body));
        if (!this.noThinkCfg) b.generationConfig = { ...(b.generationConfig || {}), thinkingConfig: { thinkingLevel: 'low' } };
        try {
          const res = await this._fetch(`/models/${model}:generateContent`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
          });
          this.model = model;
          return { js: await res.json(), model };
        } catch (e) {
          last = e;
          if (e.kind === 'bad' && /thinking/i.test(e.message) && !this.noThinkCfg) { this.noThinkCfg = true; attempt--; continue; }
          if (e.kind === 'rate' && attempt === 0) { await new Promise((r) => setTimeout(r, Math.min(20, Math.max(2, e.retry || 5)) * 1000)); continue; }
          break;
        }
      }
      if (last && last.kind === 'model' && model !== models[models.length - 1]) continue;
      throw last;
    }
    throw last || new GeminiError('model', 'no model');
  }

  // 반환 { text, lang|null, model, seconds, cost:0 } — 같은 요청에서 받은 번역은 기억해 둠
  async transcribe(samples, { mode = 'auto', pair = ['ko', 'ru'], keywords = [], prompt = '', situation = 'daily', note = '' } = {}) {
    const wav = toWav(samples);
    const seconds = samples.length / 16000;
    const langs = mode === 'auto' ? pair : [mode];
    const names = (codes) => codes.map((c) => `${lang(c).en} (${c})`).join(' or ');
    const target = (src) => (src === pair[0] ? pair[1] : pair[0]);
    const tgtNote = mode === 'auto'
      ? `If the speech is ${lang(pair[0]).en}, translate into ${lang(pair[1]).en}; if it is ${lang(pair[1]).en}, translate into ${lang(pair[0]).en}.`
      : `Translate into ${lang(target(mode)).en}.`;
    const sys = [
      `You transcribe and interpret live speech. The speaker uses ${names(langs)}.`,
      ...(lang(langs[0]).asrNote ? [lang(langs[0]).asrNote] : []),
      ...langs.slice(1).filter((c) => lang(c).asrNote).map((c) => lang(c).asrNote),
      'Step 1: write exactly what was said (verbatim, no summarizing, no added words). If there is no clear speech, return empty strings.',
      `Step 2: ${tgtNote}`,
      'Translation rules:',
      translateInstructions(langs[0], target(langs[0]), situation, note).split('\n').slice(1).join('\n'),
      keywords.length ? `Names and terms that may appear: ${keywords.slice(0, 60).join(', ')}` : '',
      prompt ? `Context:\n${prompt}` : '',
    ].filter(Boolean).join('\n');
    const body = {
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: b64(wav) } }, { text: 'Transcribe and translate this audio.' }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { lang: { type: 'STRING', enum: langs }, text: { type: 'STRING' }, translation: { type: 'STRING' } },
          required: ['lang', 'text', 'translation'],
        },
      },
    };
    const { js, model } = await this._generate(body);
    let out = {};
    try { out = JSON.parse(textOf(js) || '{}'); } catch (e) { out = { text: textOf(js) }; }
    const text = String(out.text || '').trim();
    const code = langs.includes(out.lang) ? out.lang : (langs.length === 1 ? langs[0] : null);
    if (text && out.translation) {
      this.cache.set(text, { tgt: target(code || langs[0]), text: String(out.translation).trim() });
      if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value);
    }
    return { text, lang: code, model, seconds, cost: 0 };
  }

  // 반환 { text, model, cost:0 } — 받아 적을 때 같이 받은 번역이 있으면 요청 없이 바로
  async translate(text, src, tgt, { situation = 'daily', note = '', context = [], glossary = '' } = {}) {
    for (const [k, v] of this.cache) {
      if (v.tgt === tgt && (k === text || k.replace(/\s+/g, '') === text.replace(/\s+/g, ''))) { this.cache.delete(k); return { text: v.text, model: this.model, cost: 0 }; }
    }
    const instructions = translateInstructions(src, tgt, situation, note, glossary);
    const ctx = context.filter(Boolean).slice(-3);
    const user = (ctx.length ? `Previous sentences (context only, do NOT translate):\n${ctx.join('\n')}\n\n` : '')
      + `Translate ${lang(src).en} → ${lang(tgt).en}:\n${text}`;
    const { js, model } = await this._generate({
      systemInstruction: { parts: [{ text: instructions }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2 },
    });
    const out = textOf(js);
    if (!out) throw new GeminiError('bad', 'empty');
    return { text: out, model, cost: 0 };
  }
}
