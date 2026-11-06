// 통역 흐름: 마이크 → 문장 나누기 → 음성 인식 → 번역 → 화면
import { MicCapture } from './audio.js';
import { FreeRecognizer, freeTranslate } from './free.js';
import { langName, t } from './i18n.js';
import { lang, LANGS, sameScript } from './langs.js';
import { OpenAIClient, OpenAIError } from './openai.js';
import { keywords, SITUATIONS } from './situations.js';
import { Segmenter } from './segmenter.js';
import { clean, isHallucination, langFromText, matchesLang } from './textfilter.js';

const SIT_EN = { church: 'Church service / sermon', hospital: 'Medical consultation', meeting: 'Business meeting', daily: 'Everyday', travel: 'Travel and shopping', custom: 'General' };

const PROMPTS = {
  ko: '교회 예배와 간증, 병원 진료, 회의, 일상 대화를 정확히 받아 적습니다.',
  ru: 'Точная расшифровка речи: церковь, больница, совещание, повседневный разговор.',
  en: 'Accurate transcription of speech: church, hospital, meetings, everyday conversation.',
};

export class Interpreter {
  constructor(cb) {
    this.cb = cb; // onEntry, onTranslated, onInterim, onStatus, onLevel, onNotice, onCost, onStopped
    // 대본 모드용(없어도 됨): claim(entry)→true면 대본으로 처리(번역 안 함), asrHint()→문자열, asrKeywords()→[], glossary()→문자열
    this.s = null;
    this.key = '';
    this.base = '';
    this.client = null;
    this.running = false;
    this.muted = false;
    this.nextId = 1;
    this.utts = [];
    this.recognizing = false;
    this.recent = [];
    this.cooldownUntil = 0;
  }

  configure(settings, key, base) {
    this.s = settings;
    if (key !== this.key || base !== this.base || !this.client) {
      this.key = key;
      this.base = base;
      this.client = key ? new OpenAIClient(key, base) : null;
    }
    this.seg?.setParams(settings.sensitivity, settings.silenceSec, 12);
    if (this.free) this.free.setLang(this.speakingFree());
  }

  get pair() { return [this.s.left, this.s.right]; }
  get mode() { return this.s.mode === 'openai' && this.client ? 'openai' : 'free'; }
  speakingFree() { return this.s.speaking === 'right' ? this.s.right : this.s.left; }
  speakingCode() { return this.s.speaking === 'left' ? this.s.left : this.s.speaking === 'right' ? this.s.right : 'auto'; }

  async start() {
    if (this.running) return;
    this.running = true;
    this.muted = false;
    if (this.mode === 'openai') {
      this.seg = new Segmenter(this.s.sensitivity, this.s.silenceSec, 12);
      this.mic = new MicCapture((b) => this._onBlock(b), { noiseSuppression: !!this.s.noiseSuppression });
      try {
        const name = await this.mic.start();
        this.cb.onStatus('listening', `${t('listening')} · ${name || 'mic'}`);
      } catch (e) {
        this.running = false;
        this.cb.onStatus('error', micError(e));
        this.cb.onStopped();
      }
    } else {
      this.free = new FreeRecognizer({
        onFinal: (text, code) => this._onFreeFinal(text, code),
        onInterim: (text, code) => this.cb.onInterim(text, code),
        onState: (st) => st === 'listening' && this.cb.onStatus('listening', t('listeningFree', { lang: langName(this.speakingFree(), LANGS) })),
        onError: (msg) => { this.cb.onNotice(msg); if (!this.free.running) this.stop(); },
      });
      this.free.start(this.speakingFree());
    }
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.mic) {
      const tail = this.seg?.flush();
      if (tail) this._queue(tail);
      this.mic.stop();
      this.mic = null;
    }
    if (this.free) { this.free.stop(); this.free = null; }
    this.cb.onInterim('', null);
    this.cb.onStopped();
  }

  // 읽어 주는 동안 마이크 무시(되울림 방지)
  mute(on) {
    this.muted = on;
    if (on) this.seg?.reset();
    if (this.free) this.free.pause(on);
  }

  _onBlock(block) {
    if (!this.running || this.muted) return;
    const r = this.seg.feed(block);
    this.cb.onLevel(r.level, r.threshold, r.active);
    for (const u of r.utterances) this._queue(u);
  }

  _queue(samples) {
    this.utts.push(samples);
    if (this.utts.length > 6) { this.utts.shift(); this.cb.onNotice(t('queueSkip')); }
    this._recognizeLoop();
  }

  async _recognizeLoop() {
    if (this.recognizing) return;
    this.recognizing = true;
    try {
      while (this.utts.length) {
        const samples = this.utts.shift();
        if (Date.now() < this.cooldownUntil) continue;
        this.cb.onStatus('recognizing', t('recognizing'));
        try {
          const mode = this.speakingCode();
          const kw = [...(this.cb.asrKeywords ? this.cb.asrKeywords() : []), ...keywords(this.s.situation, this.s.customTerms, this.pair, matchesLang)]
            .filter((w, i, a) => a.indexOf(w) === i).slice(0, 100);
          const r = await this.client.transcribe(samples, { mode, pair: this.pair, keywords: kw, prompt: this._asrPrompt(mode) });
          this.cb.onCost(r.cost);
          const text = clean(r.text);
          let code = mode !== 'auto' ? mode : (langFromText(text, this.pair) || r.lang);
          if (!text || isHallucination(text) || !this.pair.includes(code)) continue;
          if (!matchesLang(text, code) && !sameScript(...this.pair)) continue;
          this._emit(text, code);
        } catch (e) {
          if (e instanceof OpenAIError && (e.kind === 'auth' || e.kind === 'quota')) {
            this.cb.onNotice(e.userMessage);
            this.stop();
            return;
          }
          this.cooldownUntil = Date.now() + 5000;
          this.cb.onNotice((e.userMessage || String(e)) + t('retryLater'));
        }
      }
    } finally {
      this.recognizing = false;
      if (this.running) this.cb.onStatus('listening', t('listening'));
    }
  }

  _onFreeFinal(text, code) {
    text = clean(text);
    if (text) this._emit(text, code);
  }

  // 인식 힌트: 상황 한 줄 + 바로 앞에 받아 적은 문장(문맥). 문장이 잘려 들어와도 앞뒤를 이어 정확히 받아 적게 함.
  _asrPrompt(mode) {
    const langs = (mode === 'auto' ? this.pair : [mode]).map((c) => lang(c).en).join(' and ');
    const head = `${SIT_EN[this.s.situation] || 'General'} conversation in ${langs}.` + (this.s.note ? ` Topic: ${this.s.note}.` : '');
    const base = PROMPTS[mode] || '';
    let prev = this.recent.slice(-2).map((r) => r.orig).join(' ');
    if (prev.length > 300) prev = prev.slice(-300);
    const script = this.cb.asrHint ? this.cb.asrHint() : '';
    return [head, base, prev ? `Previous speech: ${prev}` : '', script ? `Prepared sermon script (the speaker usually follows it, but may skip, paraphrase or add words; transcribe what is actually said): ${script}` : ''].filter(Boolean).join('\n');
  }

  _emit(text, src) {
    const tgt = src === this.s.left ? this.s.right : this.s.left;
    const entry = { id: this.nextId++, src, tgt, orig: text, trans: null, ok: false, pair: [...this.pair],
      time: new Date().toTimeString().slice(0, 8), engine: this.mode };
    const ctx = this.recent.filter((r) => r.src === src).slice(-3).map((r) => r.orig);
    this.recent.push({ src, orig: text });
    this.recent = this.recent.slice(-10);
    if (this.cb.claim && this.cb.claim(entry)) return; // 대본에 있는 말: 준비된 번역을 쓰므로 번역 요청 안 함
    this.cb.onEntry(entry);
    this.translate(entry, ctx);
  }

  async translate(entry, ctx = []) {
    const { orig, src, tgt } = entry;
    try {
      if (this.mode === 'openai') {
        try {
          const glossary = this.cb.glossary ? this.cb.glossary() : '';
          const r = await this.client.translate(orig, src, tgt, { situation: this.s.situation, note: this.s.note, context: ctx, glossary });
          this.cb.onCost(r.cost);
          entry.trans = r.text; entry.ok = true;
          return;
        } catch (e) {
          this.cb.onNotice((e.userMessage || String(e)) + t('fallbackFree'));
        }
      }
      entry.trans = await freeTranslate(orig, src, tgt);
      entry.ok = true;
    } catch (e) {
      entry.trans = t('translateFailed');
      entry.ok = false;
    } finally {
      this.cb.onTranslated(entry);
    }
  }
}

function micError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return t('micDenied');
  if (n === 'NotFoundError') return t('micNotFound');
  if (n === 'NotReadableError') return t('micBusy');
  return t('micOther', { e: e && e.message ? e.message : String(e) });
}

export const situationWarning = (key) => ((SITUATIONS[key] || {}).warning ? t('hospitalWarn') : '');
