// OpenAI 호출 (브라우저에서 사용자의 키로 직접 호출)
import { t } from './i18n.js';
import { lang } from './langs.js';
import { translateInstructions } from './situations.js';
import { looksTranslated } from './textfilter.js';
import { toWav, wavDuration } from './wav.js';

export const ASR_MODELS = ['gpt-transcribe', 'gpt-4o-transcribe'];
export const TEXT_MODELS = ['gpt-6-luna', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-4.1-mini'];
export const TTS_MODELS = ['gpt-4o-mini-tts'];
// 2026-10 공식 가격표 기준 추정치
const ASR_PER_MIN = { 'gpt-transcribe': 0.0045, 'gpt-4o-transcribe': 0.006 };
const TEXT_PER_MTOK = { 'gpt-6-luna': [0.1, 0.5], 'gpt-5.4-nano': [0.2, 1.25], 'gpt-5.4-mini': [0.75, 4.5] };
const TTS_PER_MIN = 0.015;

export class OpenAIError extends Error {
  constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; }
  get userMessage() {
    return t(`oa_${['auth', 'quota', 'network', 'rate', 'server', 'model'].includes(this.kind) ? this.kind : 'bad'}`, { e: this.message });
  }
}

async function classify(res) {
  let msg = '', code = '';
  try {
    const js = await res.json();
    msg = js?.error?.message || ''; code = js?.error?.code || js?.error?.type || '';
  } catch (e) { msg = res.statusText; }
  const s = res.status, low = `${code} ${msg}`.toLowerCase();
  if (s === 401 || low.includes('invalid_api_key') || low.includes('incorrect api key')) return new OpenAIError('auth', msg, s);
  if (low.includes('insufficient_quota') || low.includes('billing') || low.includes('spend_limit') || s === 402) return new OpenAIError('quota', msg, s);
  if (s === 429) return new OpenAIError('rate', msg, s);
  if (low.includes('model_not_found') || (low.includes('model') && /does not exist|not supported|not found|invalid/.test(low))) return new OpenAIError('model', msg, s);
  if (s >= 500) return new OpenAIError('server', msg, s);
  return new OpenAIError('bad', msg, s);
}

export class OpenAIClient {
  constructor(key, base = 'https://api.openai.com/v1') {
    this.key = key;
    this.base = base.replace(/\/$/, '');
    this.asrModel = null;
    this.textModel = null;
    this.noReasoning = new Set();
  }

  async _fetch(path, opts = {}, timeoutMs = 25000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(this.base + path, {
        ...opts, signal: ctl.signal,
        headers: { Authorization: `Bearer ${this.key}`, ...(opts.headers || {}) },
      });
    } catch (e) {
      throw new OpenAIError('network', e.name === 'AbortError' ? '응답 시간 초과' : String(e));
    } finally { clearTimeout(timer); }
    if (!res.ok) throw await classify(res);
    return res;
  }

  async check() {
    const res = await this._fetch('/models', {}, 15000);
    const js = await res.json();
    return (js.data || []).length;
  }

  // 반환 { text, lang|null, model, seconds, cost }
  async transcribe(samples, { mode = 'auto', pair = ['ko', 'ru'], keywords = [], prompt = '' } = {}) {
    const wav = toWav(samples);
    const seconds = samples.length / 16000;
    const langs = mode === 'auto' ? pair : [mode];
    const models = this.asrModel ? [this.asrModel] : ASR_MODELS;
    let last;
    for (const model of models) {
      const fd = new FormData();
      fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
      fd.append('model', model);
      if (model === 'gpt-transcribe') {
        langs.forEach((l) => fd.append('languages[]', l));
        keywords.forEach((k) => fd.append('keywords[]', k));
      } else if (langs.length === 1) fd.append('language', langs[0]);
      if (langs.length === 1 && prompt) fd.append('prompt', prompt);
      try {
        const res = await this._fetch('/audio/transcriptions', { method: 'POST', body: fd }, 30000);
        const js = await res.json();
        this.asrModel = model;
        const code = (js.languages || []).map((x) => (x.code || '').slice(0, 2).toLowerCase()).find((c) => langs.includes(c));
        return { text: (js.text || '').trim(), lang: code || null, model, seconds, cost: (seconds / 60) * (ASR_PER_MIN[model] ?? 0.006) };
      } catch (e) {
        last = e;
        if ((e.kind === 'model' || e.kind === 'bad') && model !== models[models.length - 1]) continue;
        throw e;
      }
    }
    throw last || new OpenAIError('model', '사용 가능한 인식 모델 없음');
  }

  // 반환 { text, model, cost }
  async translate(text, src, tgt, { situation = 'daily', note = '', context = [] } = {}) {
    const instructions = translateInstructions(src, tgt, situation, note);
    const dir = `${lang(src).en} → ${lang(tgt).en} (${lang(tgt).native})`;
    const ctx = context.filter(Boolean).slice(-3);
    const user = (ctx.length ? `Previous sentences (context only, do NOT translate):\n${ctx.join('\n')}\n\n` : '') + `Translate ${dir}:\n${text}`;
    const strong = `Translate the following ${lang(src).en} text into ${lang(tgt).en} (${lang(tgt).native}). Your answer MUST be written in ${lang(tgt).en} only. Do not repeat the original.\n\n${text}`;
    const start = this.textModel ? TEXT_MODELS.indexOf(this.textModel) : 0;
    const models = TEXT_MODELS.slice(Math.max(0, start));
    let last, cost = 0;
    for (const model of models) {
      for (const input of [user, strong]) {
        let r;
        try { r = await this._responses(model, instructions, input); } catch (e) {
          last = e;
          if (e.kind === 'model') break;
          throw e;
        }
        const [pin, pout] = TEXT_PER_MTOK[model] || [2.5, 10];
        cost += (r.inTok / 1e6) * pin + (r.outTok / 1e6) * pout;
        if (looksTranslated(text, r.text, tgt)) { this.textModel = model; return { text: r.text, model, cost }; }
        last = new OpenAIError('bad', `번역 결과가 ${lang(tgt).en}가 아님`);
      }
    }
    throw last || new OpenAIError('model', '사용 가능한 번역 모델 없음');
  }

  async _responses(model, instructions, input) {
    const body = { model, instructions, input };
    if (/^gpt-[56]/.test(model) && !this.noReasoning.has(model)) body.reasoning = { effort: 'low' };
    let res;
    try {
      res = await this._fetch('/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      if (e.kind === 'bad' && /reasoning/i.test(e.message) && body.reasoning) { this.noReasoning.add(model); return this._responses(model, instructions, input); }
      throw e;
    }
    const js = await res.json();
    let out = js.output_text || '';
    if (!out) for (const item of js.output || []) for (const c of item.content || []) if ((c.type === 'output_text' || c.type === 'text') && c.text) out += c.text;
    out = out.trim();
    if (!out) throw new OpenAIError('bad', '빈 번역 결과');
    return { text: out, inTok: js.usage?.input_tokens || 0, outTok: js.usage?.output_tokens || 0 };
  }

  // 반환 { wav: Uint8Array, cost }
  async speech(text, code, voice = 'coral') {
    const res = await this._fetch('/audio/speech', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TTS_MODELS[0], input: text.slice(0, 4000), voice, response_format: 'wav',
        instructions: `Read this ${lang(code).en} text aloud clearly, warmly and calmly at a moderate pace, like a professional interpreter. Pronounce names carefully.`,
      }),
    }, 40000);
    const wav = new Uint8Array(await res.arrayBuffer());
    return { wav, cost: ((wavDuration(wav) || text.length / 12) / 60) * TTS_PER_MIN };
  }
}
