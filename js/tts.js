// 번역문 소리 내어 읽기: OpenAI 음성(키가 있을 때) → 브라우저 내장 음성
import { freeSpeak } from './free.js';
import { t } from './i18n.js';

export const VOICES = ['coral', 'nova', 'sage', 'alloy', 'shimmer', 'marin', 'cedar', 'echo', 'onyx'];
const MAX_PENDING = 3;

export class Speaker {
  constructor({ onStart, onEnd, onNotice, onCost }) {
    this.cb = { onStart, onEnd, onNotice, onCost };
    this.queue = [];
    this.gen = 0;
    this.busy = false;
    this.client = null;
    this.voice = 'coral';
    this.offUntil = 0;
    this.ctx = null;
    this.source = null;
  }

  configure(client, voice) { this.client = client; this.voice = voice; this.offUntil = 0; }

  say(text, code, id) {
    if (!text) return;
    this.queue.push({ text, code, id, gen: this.gen });
    while (this.queue.length > MAX_PENDING) this.queue.shift();
    this._next();
  }

  stopAll() {
    this.gen++;
    this.queue = [];
    try { this.source && this.source.stop(); } catch (e) { /* 무시 */ }
    if ('speechSynthesis' in self) speechSynthesis.cancel();
  }

  async _next() {
    if (this.busy) return;
    const item = this.queue.shift();
    if (!item) return;
    if (item.gen !== this.gen) return this._next();
    this.busy = true;
    this.cb.onStart?.(item);
    try {
      const cancelled = () => item.gen !== this.gen;
      let played = false;
      if (this.client && Date.now() >= this.offUntil) {
        try {
          const { wav, cost } = await this.client.speech(item.text, item.code, this.voice);
          this.cb.onCost?.(cost);
          if (!cancelled()) await this._playWav(wav, cancelled);
          played = true;
        } catch (e) {
          this.offUntil = Date.now() + (e.kind === 'auth' || e.kind === 'quota' ? 600000 : 30000);
          this.cb.onNotice?.((e.userMessage || String(e)) + t('fallbackVoice'));
        }
      }
      if (!played && !cancelled()) await freeSpeak(item.text, item.code, cancelled);
    } finally {
      this.busy = false;
      this.cb.onEnd?.(item);
      this._next();
    }
  }

  async _playWav(bytes, cancelled) {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const buf = await this.ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    await new Promise((resolve) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.onended = () => { clearInterval(iv); this.source = null; resolve(); };
      const iv = setInterval(() => { if (cancelled()) { try { src.stop(); } catch (e) { /* 무시 */ } } }, 100);
      this.source = src;
      src.start();
    });
  }
}
