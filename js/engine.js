// 통역 흐름: 마이크 → 문장 나누기 → 음성 인식 → 번역 → 화면
import { MicCapture } from './audio.js';
import { FreeRecognizer, freeTranslate } from './free.js';
import { lang, sameScript } from './langs.js';
import { OpenAIClient, OpenAIError } from './openai.js';
import { keywords, SITUATIONS } from './situations.js';
import { Segmenter } from './segmenter.js';
import { clean, isHallucination, langFromText, matchesLang } from './textfilter.js';

const PROMPTS = {
  ko: '교회 예배와 간증, 병원 진료, 회의, 일상 대화를 정확히 받아 적습니다.',
  ru: 'Точная расшифровка речи: церковь, больница, совещание, повседневный разговор.',
  en: 'Accurate transcription of speech: church, hospital, meetings, everyday conversation.',
};

export class Interpreter {
  constructor(cb) {
    this.cb = cb; // onEntry, onTranslated, onInterim, onStatus, onLevel, onNotice, onCost, onStopped
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
      this.mic = new MicCapture((b) => this._onBlock(b));
      try {
        const name = await this.mic.start();
        this.cb.onStatus('listening', `듣는 중 · ${name || '마이크'}`);
      } catch (e) {
        this.running = false;
        this.cb.onStatus('error', micError(e));
        this.cb.onStopped();
      }
    } else {
      this.free = new FreeRecognizer({
        onFinal: (text, code) => this._onFreeFinal(text, code),
        onInterim: (text, code) => this.cb.onInterim(text, code),
        onState: (st) => st === 'listening' && this.cb.onStatus('listening', `듣는 중 · ${lang(this.speakingFree()).name} (무료 모드)`),
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
    if (this.utts.length > 6) { this.utts.shift(); this.cb.onNotice('처리가 밀려 이전 음성 하나를 건너뛰었습니다.'); }
    this._recognizeLoop();
  }

  async _recognizeLoop() {
    if (this.recognizing) return;
    this.recognizing = true;
    try {
      while (this.utts.length) {
        const samples = this.utts.shift();
        if (Date.now() < this.cooldownUntil) continue;
        this.cb.onStatus('recognizing', '음성을 글자로 바꾸는 중…');
        try {
          const mode = this.speakingCode();
          const kw = keywords(this.s.situation, this.s.customTerms, this.pair, matchesLang);
          const r = await this.client.transcribe(samples, { mode, pair: this.pair, keywords: kw, prompt: PROMPTS[mode] || '' });
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
          this.cb.onNotice((e.userMessage || String(e)) + ' 잠시 후 다시 시도합니다.');
        }
      }
    } finally {
      this.recognizing = false;
      if (this.running) this.cb.onStatus('listening', '듣는 중');
    }
  }

  _onFreeFinal(text, code) {
    text = clean(text);
    if (text) this._emit(text, code);
  }

  _emit(text, src) {
    const tgt = src === this.s.left ? this.s.right : this.s.left;
    const entry = { id: this.nextId++, src, tgt, orig: text, trans: null, ok: false, pair: [...this.pair],
      time: new Date().toTimeString().slice(0, 8), engine: this.mode };
    this.cb.onEntry(entry);
    const ctx = this.recent.filter((r) => r.src === src).slice(-3).map((r) => r.orig);
    this.recent.push({ src, orig: text });
    this.recent = this.recent.slice(-10);
    this.translate(entry, ctx);
  }

  async translate(entry, ctx = []) {
    const { orig, src, tgt } = entry;
    try {
      if (this.mode === 'openai') {
        try {
          const r = await this.client.translate(orig, src, tgt, { situation: this.s.situation, note: this.s.note, context: ctx });
          this.cb.onCost(r.cost);
          entry.trans = r.text; entry.ok = true;
          return;
        } catch (e) {
          if (e.kind === 'auth' || e.kind === 'quota') this.cb.onNotice(e.userMessage + ' → 무료 번역으로 대신합니다.');
          else this.cb.onNotice((e.userMessage || String(e)) + ' → 무료 번역으로 대신합니다.');
        }
      }
      entry.trans = await freeTranslate(orig, src, tgt);
      entry.ok = true;
    } catch (e) {
      entry.trans = '[번역 실패 — 인터넷 연결을 확인하세요]';
      entry.ok = false;
    } finally {
      this.cb.onTranslated(entry);
    }
  }
}

function micError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return '마이크 사용이 허용되지 않았습니다. 주소창 왼쪽 자물쇠 → 마이크 → 허용으로 바꿔 주세요.';
  if (n === 'NotFoundError') return '마이크를 찾지 못했습니다.';
  if (n === 'NotReadableError') return '다른 앱이 마이크를 쓰고 있습니다. 다른 앱을 닫고 다시 시도하세요.';
  return `마이크를 열 수 없습니다: ${e && e.message ? e.message : e}`;
}

export const situationWarning = (key) => (SITUATIONS[key] || {}).warning || '';
