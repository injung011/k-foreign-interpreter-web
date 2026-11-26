// OpenAI 실시간 받아 적기(스트리밍) — 말하는 동안 소리를 계속 보내고, 말하는 중에도 글자를 받음.
// 공식 안내(Realtime transcription): wss://…/v1/realtime?intent=transcription, 세션 type 'transcription',
// 소리 형식 PCM16 24kHz(base64), 모델 gpt-live-transcribe, 말 끝마다 input_audio_buffer.commit.
// 문장이 끝나는 시점은 앱의 문장 나누기(Segmenter)가 정하므로 turn_detection은 끔(null).
//
// 브라우저에서는 웹소켓 머리말을 못 붙여서 서브프로토콜로 키를 전달(공식 예제의 방식).
// 키는 사용자 본인의 키이고 이 브라우저에서 OpenAI로만 감.

export const RT_MODEL = 'gpt-live-transcribe';
const RT_RATE = 24000;

// 16kHz Float32 → 24kHz PCM16(직선 보간). 블록 사이를 이어 붙이도록 마지막 값을 기억.
export class Upsampler {
  constructor() { this.prev = 0; this.pos = 0; } // pos: 이번 블록 기준 입력 위치(-1 = 앞 블록의 마지막 샘플)
  process(block) {
    const n = block.length;
    const get = (i) => (i < 0 ? this.prev : block[i]);
    const out = [];
    let p = this.pos;
    while (p <= n - 1) {
      const i = Math.floor(p), f = p - i;
      const a = get(i);
      out.push(f ? a + (get(i + 1) - a) * f : a);
      p += 16000 / RT_RATE;
    }
    this.pos = p - n;
    if (n) this.prev = block[n - 1];
    const pcm = new Int16Array(out.length);
    for (let k = 0; k < out.length; k++) pcm[k] = Math.max(-32768, Math.min(32767, Math.round(out[k] * 32767)));
    return pcm;
  }
}

function b64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class RealtimeASR {
  // cb: onCommitted(itemId), onDelta(itemId, textSoFar), onCompleted(itemId, text), onFailed(itemId, msg), onClosed(reason)
  constructor(key, base, cb) {
    this.key = key;
    this.url = base.replace(/^http/, 'ws').replace(/\/$/, '') + '/realtime?intent=transcription';
    this.cb = cb;
    this.ws = null;
    this.ready = false;
    this.text = new Map(); // item_id → 지금까지 받은 글자
    this.sentSec = 0;
  }

  connect({ languages, prompt = '', keywords = [] }, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(); };
      const timer = setTimeout(() => { finish(new Error('timeout')); this.close(); }, timeoutMs);
      let ws;
      try { ws = new WebSocket(this.url, ['realtime', 'openai-insecure-api-key.' + this.key]); } catch (e) { finish(e); return; }
      this.ws = ws;
      ws.onopen = () => {
        const transcription = { model: RT_MODEL, languages, delay: 'low' };
        if (prompt) transcription.prompt = prompt.slice(0, 2000);
        if (keywords.length) transcription.keywords = keywords.slice(0, 60);
        this._send({
          type: 'session.update',
          session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: RT_RATE }, transcription, turn_detection: null } } },
        });
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        switch (m.type) {
          case 'session.updated':
          case 'transcription_session.updated':
            clearTimeout(this.createdTimer);
            this.ready = true; finish(); break;
          case 'session.created':
          case 'transcription_session.created':
            // 설정 확인(updated)이 따로 안 오는 경우를 대비해 잠시 뒤 준비된 것으로
            this.createdTimer = setTimeout(() => { if (!done && this.ws) { this.ready = true; finish(); } }, 2500);
            break;
          case 'input_audio_buffer.committed':
            this.cb.onCommitted(m.item_id); break;
          case 'conversation.item.input_audio_transcription.delta': {
            const t = (this.text.get(m.item_id) || '') + (m.delta || '');
            this.text.set(m.item_id, t);
            this.cb.onDelta(m.item_id, t);
            break;
          }
          case 'conversation.item.input_audio_transcription.completed':
            this.text.delete(m.item_id);
            this.cb.onCompleted(m.item_id, m.transcript || '');
            break;
          case 'conversation.item.input_audio_transcription.failed':
            this.text.delete(m.item_id);
            this.cb.onFailed(m.item_id, (m.error && m.error.message) || 'failed');
            break;
          case 'error':
            clearTimeout(this.createdTimer);
            if (!this.ready) { finish(new Error((m.error && m.error.message) || 'error')); this.close(); }
            else if (this.cb.onError) this.cb.onError((m.error && m.error.message) || 'error');
            break;
          default:
        }
      };
      ws.onerror = () => { if (!this.ready) finish(new Error('connect failed')); };
      ws.onclose = (ev) => {
        const was = this.ready;
        this.ready = false;
        this.ws = null;
        if (!done) finish(new Error(`closed ${ev.code}`));
        else if (was) this.cb.onClosed(`closed ${ev.code}`);
      };
    });
  }

  _send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  append(pcm16) { if (pcm16.length) { this._send({ type: 'input_audio_buffer.append', audio: b64(pcm16) }); this.sentSec += pcm16.length / RT_RATE; } }
  commit() { this._send({ type: 'input_audio_buffer.commit' }); }
  updatePrompt(prompt) {
    this._send({ type: 'session.update', session: { type: 'transcription', audio: { input: { transcription: { model: RT_MODEL, prompt: prompt.slice(0, 2000) } } } } });
  }
  close() { try { this.ws && this.ws.close(); } catch (e) { /* 무시 */ } this.ws = null; this.ready = false; }
}
