// 통역 흐름: 마이크 → 문장 나누기 → 음성 인식 → 번역 → 화면
import { MicCapture } from './audio.js';
import { FreeRecognizer, freeTranslate } from './free.js';
import { langName, t } from './i18n.js';
import { asrCodes, lang, LANGS, sameScript } from './langs.js';
import { RealtimeASR, Upsampler } from './realtime.js';
import { OpenAIClient, OpenAIError } from './openai.js';
import { keywords, SITUATIONS } from './situations.js';
import { Segmenter } from './segmenter.js';
import { clean, isHallucination, langFromText, matchesLang } from './textfilter.js';

const MAX_PARALLEL = 3;
const MAX_SEG_SEC = 8; // 쉬지 않고 길게 말할 때 이 길이마다 가장 조용한 곳에서 잘라 보냄
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
    this.inflight = 0;
    this.seqIn = 0;
    this.seqOut = 0;
    this.done = new Map();
    this.lost = 0;
    this.rt = null;
    this.rtPending = [];
    this.rtById = new Map();
    this.rtStreaming = false;
    this.recent = [];
  }

  // client: OpenAIClient 또는 GeminiClient(같은 모양), 없으면 무료 모드
  configure(settings, client) {
    this.s = settings;
    this.client = client || null;
    this.seg?.setParams(settings.sensitivity, settings.silenceSec, MAX_SEG_SEC);
    if (this.free) this.free.setLang(this.speakingFree());
  }

  get pair() { return [this.s.left, this.s.right]; }
  get mode() { return this.client ? 'cloud' : 'free'; }
  speakingFree() { return this.s.speaking === 'right' ? this.s.right : this.s.left; }
  speakingCode() { return this.s.speaking === 'left' ? this.s.left : this.s.speaking === 'right' ? this.s.right : 'auto'; }

  async start() {
    if (this.running) return;
    this.running = true;
    this.muted = false;
    if (this.mode === 'cloud') {
      this.seg = new Segmenter(this.s.sensitivity, this.s.silenceSec, MAX_SEG_SEC);
      this.ring = [];
      this.prevActive = false;
      this.rtFailCount = 0;
      this.mic = new MicCapture((b) => this._onBlock(b), { noiseSuppression: !!this.s.noiseSuppression });
      try {
        const name = await this.mic.start();
        this.micName = name;
        this.cb.onStatus('listening', `${t('listening')} · ${name || 'mic'}`);
        if (this._rtWanted()) this._rtConnect();
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
      if (tail) this._submit(tail);
      this.mic.stop();
      this.mic = null;
    }
    this.rtStreaming = false;
    // 실시간 연결은 남은 결과를 받을 때까지 잠시 두었다가 닫음(못 받은 건 기본 방식으로)
    if (this.rt) { const rt = this.rt; this.rt = null; setTimeout(() => { rt.close(); this._rtFallbackAll(); }, 8000); }
    if (this.free) { this.free.stop(); this.free = null; }
    this.cb.onInterim('', null);
    this.cb.onStopped();
  }

  // 읽어 주는 동안 마이크 무시(되울림 방지)
  mute(on) {
    this.muted = on;
    if (on) {
      if (this.rtStreaming) { const tail = this.seg?.flush(); if (tail) this._submit(tail); else this.rtStreaming = false; }
      this.seg?.reset();
    }
    if (this.free) this.free.pause(on);
  }

  _onBlock(block) {
    if (!this.running || this.muted) return;
    const r = this.seg.feed(block);
    this.cb.onLevel(r.level, r.threshold, r.active);
    // 실시간: 말이 시작되면(앞 여유 포함) 그때부터 소리를 계속 흘려보냄
    this.ring = (this.ring || []);
    this.ring.push(block);
    if (this.ring.length > 9) this.ring.shift();
    if (this.rt && this.rt.ready) {
      if (r.active && !this.rtStreaming && !this.prevActive) { // 문장이 막 시작될 때만(중간부터면 다음 문장부터)
        this.rtStreaming = true;
        for (const b of this.ring) this.rt.append(this.up.process(b));
      } else if (this.rtStreaming) this.rt.append(this.up.process(block));
    }
    for (const u of r.utterances) this._submit(u);
    if (!r.active) this.rtStreaming = false;
    this.prevActive = r.active;
  }

  // 한 문장(조각)이 끝남 → 실시간 연결이면 commit, 아니면 기본 방식(파일로 보내기)
  _submit(samples) {
    const seq = this.seqIn++;
    if (this.rt && this.rt.ready && this.rtStreaming) {
      this.rt.commit();
      const p = { seq, samples, timer: setTimeout(() => this._rtGiveUp(p), 15000) };
      this.rtPending.push(p);
      this.cb.onStatus('recognizing', t('recognizing'));
      return;
    }
    this.utts.push({ samples, seq });
    this._pump();
  }

  // 받아 적기: 버리지 않고, 최대 3개를 동시에 보내고, 결과는 말한 순서대로 화면에 냄
  _queue(samples) { this._submit(samples); }

  // ---------------- 실시간(스트리밍) 받아 적기
  _rtWanted() {
    if (!this.s.realtime || !(this.client instanceof OpenAIClient)) return false;
    // 같은 글자 체계의 두 언어를 '자동'으로 구분해야 하면 기본 방식(실시간은 언어를 알려 주지 않음)
    if (this.speakingCode() === 'auto' && sameScript(...this.pair)) return false;
    return true;
  }

  async _rtConnect() {
    if (this.rtConnecting) return;
    this.rtConnecting = true;
    const mode = this.speakingCode();
    const langs = [...new Set((mode === 'auto' ? this.pair : [mode]).flatMap(asrCodes))];
    const kw = [...(this.cb.asrKeywords ? this.cb.asrKeywords() : []), ...keywords(this.s.situation, this.s.customTerms, this.pair, matchesLang)]
      .filter((w, i, a) => a.indexOf(w) === i).slice(0, 60);
    const rt = new RealtimeASR(this.client.key, this.rtBase || this.client.base, {
      onCommitted: (id) => {
        const p = this.rtPending.find((x) => !x.id);
        if (p) { p.id = id; this.rtById.set(id, p); }
      },
      onDelta: (id, textSoFar) => {
        const code = mode !== 'auto' ? mode : (langFromText(textSoFar, this.pair) || this.pair[0]);
        this.cb.onInterim(textSoFar, code);
      },
      onCompleted: (id, text) => {
        const p = this.rtById.get(id);
        if (!p) return;
        this._rtDone(p, { r: { text, lang: null, cost: 0 }, mode });
      },
      onFailed: (id) => { const p = this.rtById.get(id); if (p) this._rtGiveUp(p); },
      onClosed: () => {
        if (this.rt === rt) this.rt = null;
        this.rtStreaming = false;
        this._rtFallbackAll();
        if (this.running) { this.cb.onNotice(t('rtLost')); setTimeout(() => this.running && !this.rt && this._rtWanted() && this._rtConnect(), 5000); }
      },
      onError: () => {},
    });
    try {
      await rt.connect({ languages: langs, prompt: this._asrPrompt(mode), keywords: kw });
      if (!this.running) { rt.close(); return; }
      this.rt = rt;
      this.up = new Upsampler();
      this.rtMode = mode;
      this.cb.onStatus('listening', `${t('listening')} · ⚡${t('rtOn')}`);
    } catch (e) {
      this.rtFailCount = (this.rtFailCount || 0) + 1;
      if (this.rtFailCount === 1) this.cb.onNotice(t('rtFail'));
    } finally { this.rtConnecting = false; }
  }

  _rtDone(p, result) {
    clearTimeout(p.timer);
    this.rtPending = this.rtPending.filter((x) => x !== p);
    if (p.id) this.rtById.delete(p.id);
    // 대략 요금(받아 적은 소리 길이 기준)
    this.cb.onCost((p.samples.length / 16000 / 60) * 0.006);
    this._deliver(p.seq, result.r.text ? result : null);
    if (!this.rtPending.length && !this.utts.length && !this.inflight && this.running) this.cb.onStatus('listening', `${t('listening')} · ⚡${t('rtOn')}`);
  }

  // 실시간으로 결과가 안 오면 그 조각은 기본 방식으로 다시
  _rtGiveUp(p) {
    clearTimeout(p.timer);
    this.rtPending = this.rtPending.filter((x) => x !== p);
    if (p.id) this.rtById.delete(p.id);
    this.utts.push({ samples: p.samples, seq: p.seq });
    this._pump();
  }

  _rtFallbackAll() { for (const p of [...this.rtPending]) this._rtGiveUp(p); }

  _pump() {
    while (this.inflight < MAX_PARALLEL && this.utts.length) {
      const u = this.utts.shift();
      this.inflight++;
      this._recognize(u).finally(() => { this.inflight--; this._pump(); });
    }
    const waiting = this.utts.length + this.inflight;
    if (waiting) this.cb.onStatus('recognizing', t('recognizing') + (waiting > 1 ? ` (${waiting})` : ''));
    else if (this.running) this.cb.onStatus('listening', t('listening'));
  }

  async _recognize(u) {
    let result = null;
    const mode = this.speakingCode();
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      try {
        const kw = [...(this.cb.asrKeywords ? this.cb.asrKeywords() : []), ...keywords(this.s.situation, this.s.customTerms, this.pair, matchesLang)]
          .filter((w, i, a) => a.indexOf(w) === i).slice(0, 100);
        const r = await this.client.transcribe(u.samples, { mode, pair: this.pair, keywords: kw, prompt: this._asrPrompt(mode), situation: this.s.situation, note: this.s.note,
          glossary: this.cb.glossary ? this.cb.glossary() : '', reference: this.cb.reference ? this.cb.reference() : '' });
        this.cb.onCost(r.cost);
        result = { r, mode };
      } catch (e) {
        if (e instanceof OpenAIError && (e.kind === 'auth' || e.kind === 'quota')) {
          this.cb.onNotice(e.userMessage);
          this.stop();
          break;
        }
        if (attempt === 2) { this.lost++; this.cb.onNotice((e.userMessage || String(e)) + t('retryLater')); }
        else await new Promise((res) => setTimeout(res, 700 * (attempt + 1))); // 잠깐 쉬고 다시 시도
      }
    }
    this._deliver(u.seq, result);
  }

  // 결과를 말한 순서대로 화면에 냄(실시간·기본 방식 섞여도)
  _deliver(seq, result) {
    this.done.set(seq, result);
    while (this.done.has(this.seqOut)) {
      const d = this.done.get(this.seqOut);
      this.done.delete(this.seqOut);
      this.seqOut++;
      if (d) this._accept(d.r, d.mode);
    }
    if (result) this.cb.onInterim('', null);
  }

  _accept(r, mode) {
    const text = clean(r.text);
    const code = mode !== 'auto' ? mode : (langFromText(text, this.pair) || r.lang);
    if (!text || isHallucination(text) || !this.pair.includes(code)) return;
    if (this._isEcho(text)) return; // 힌트로 보낸 '앞 문장'을 인식이 그대로 따라 적은 것
    if (!matchesLang(text, code) && !sameScript(...this.pair)) return;
    this._emit(text, code);
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
    const notes = (mode === 'auto' ? this.pair : [mode]).map((c) => lang(c).asrNote).filter(Boolean).join(' ');
    let prev = this.recent.slice(-2).map((r) => r.orig).join(' ');
    if (prev.length > 300) prev = prev.slice(-300);
    const script = this.cb.asrHint ? this.cb.asrHint() : '';
    return [head, base, notes, prev ? `Previous speech: ${prev}` : '', script ? `Prepared sermon script (the speaker usually follows it, but may skip, paraphrase or add words; transcribe what is actually said): ${script}` : ''].filter(Boolean).join('\n');
  }

  // 조용하거나 잘 안 들릴 때 음성 인식이 힌트(바로 앞에 한 말)를 그대로 다시 적는 경우가 있어 걸러 냄
  _isEcho(text) {
    // 힌트를 그대로 따라 적을 때는 글자 하나 안 틀리고 똑같이 나옴 → 완전히 같은 문장(또는 앞 문장의 일부를 그대로)만 거름.
    // 비슷하기만 한 문장은 실제로 다시 말한 것일 수 있어 버리지 않음.
    const n = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const a = n(text);
    if (a.length < 6) return false;
    return this.recent.slice(-3).some((r) => { const b = n(r.orig); return b === a || (a.length >= 15 && b.includes(a)); });
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
    if (entry.preset) { // 대본 참고 모드: 한 구간을 거의 그대로 말함 → 준비된 번역을 바로
      entry.trans = entry.preset; entry.ok = true;
      this.cb.onTranslated(entry);
      return;
    }
    try {
      if (this.mode === 'cloud') {
        try {
          const glossary = this.cb.glossary ? this.cb.glossary() : '';
          const reference = this.cb.reference ? this.cb.reference() : '';
          const r = await this.client.translate(orig, src, tgt, { situation: this.s.situation, note: this.s.note, context: ctx, glossary, reference });
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
