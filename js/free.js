// 무료 모드: 브라우저 내장 음성 인식(크롬), 무료 번역, 브라우저 내장 읽기
import { langName, t } from './i18n.js';
import { googleCode, lang, LANGS } from './langs.js';

export const freeRecognitionSupported = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);

// 크롬 음성 인식: 한 번에 한 언어. 말이 끊기면 자동으로 다시 시작.
export class FreeRecognizer {
  constructor({ onFinal, onInterim, onState, onError }) {
    this.cb = { onFinal, onInterim, onState, onError };
    this.running = false;
    this.paused = false;
    this.rec = null;
    this.code = 'ko';
    this.backoff = 300;
  }

  start(code) {
    this.code = code;
    this.running = true;
    this.paused = false;
    this._open();
  }

  setLang(code) {
    if (code === this.code) return;
    this.code = code;
    if (this.rec) this.rec.abort(); // onend에서 새 언어로 다시 시작
  }

  pause(p) {
    this.paused = p;
    if (p && this.rec) this.rec.abort();
    if (!p && this.running && !this.rec) this._open();
  }

  stop() {
    this.running = false;
    if (this.rec) this.rec.abort();
    this.rec = null;
  }

  _open() {
    if (!this.running || this.paused || this.rec) return;
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new R();
    rec.lang = lang(this.code).bcp;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => { this.backoff = 300; this.cb.onState?.('listening'); };
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.cb.onFinal?.(r[0].transcript.trim(), this.code);
        else interim += r[0].transcript;
      }
      this.cb.onInterim?.(interim.trim(), this.code);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.running = false;
        this.cb.onError?.(t('micDenied'));
        return;
      }
      if (e.error === 'language-not-supported') {
        this.running = false;
        this.cb.onError?.(t('freeLangUnsupported', { lang: langName(this.code, LANGS) }));
        return;
      }
      this.backoff = Math.min(this.backoff * 2, 8000);
      this.cb.onError?.(t('freeConn', { e: e.error }));
    };
    rec.onend = () => {
      this.rec = null;
      if (this.running && !this.paused) setTimeout(() => this._open(), this.backoff);
    };
    this.rec = rec;
    try { rec.start(); } catch (e) { this.rec = null; setTimeout(() => this._open(), 1000); }
  }
}

// 무료 번역: 크롬 기기 내 번역(Translator API, 지원 기기만) → Google 무료 경로
const translators = new Map();
export async function freeTranslate(text, src, tgt) {
  if ('Translator' in self) {
    try {
      const key = `${src}-${tgt}`;
      let t = translators.get(key);
      if (!t) {
        const avail = await self.Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
        if (avail !== 'unavailable') {
          t = await self.Translator.create({ sourceLanguage: src, targetLanguage: tgt });
          translators.set(key, t);
        }
      }
      if (t) return await t.translate(text);
    } catch (e) { /* 다음 방법으로 */ }
  }
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
    + `&sl=${encodeURIComponent(googleCode(src))}&tl=${encodeURIComponent(googleCode(tgt))}&q=${encodeURIComponent(text)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const js = await res.json();
    const out = (js[0] || []).map((p) => (p && typeof p[0] === 'string' ? p[0] : '')).join('').trim();
    if (!out) throw new Error('빈 결과');
    return out;
  } finally { clearTimeout(timer); }
}

// 브라우저 내장 읽기
export function freeSpeak(text, code, cancelled) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in self)) return resolve(false);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang(code).bcp;
    const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.toLowerCase().startsWith(code));
    if (v) u.voice = v;
    u.rate = 1.0;
    const done = () => { clearInterval(iv); resolve(true); };
    u.onend = done;
    u.onerror = done;
    const iv = setInterval(() => { if (cancelled()) { speechSynthesis.cancel(); done(); } }, 100);
    speechSynthesis.speak(u);
  });
}

export const hasBrowserVoice = (code) =>
  'speechSynthesis' in self && speechSynthesis.getVoices().some((x) => x.lang && x.lang.toLowerCase().startsWith(code));
