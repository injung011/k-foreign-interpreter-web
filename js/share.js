// 보기 전용 공유: 통역하는 기기(host)가 자막을 방(room)에 보내고, 보는 사람(viewer)은 받기만 함.
// 전송 방법 두 가지 — 같은 메시지 규칙:
//   supabase : Supabase Realtime 방송(다른 기기끼리). config.js 설정 필요.
//   local    : 같은 브라우저의 다른 창/탭(BroadcastChannel). 서버 없이 동작 — 노트북에서 빔프로젝터용 창을 따로 띄울 때.
// 메시지: host→ {t:'state'} {t:'entry', e} {t:'snapshot', entries, state} {t:'end'} / viewer→ {t:'join', v}
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config.js';

export const supabaseConfigured = () => !!(SUPABASE_URL && SUPABASE_ANON_KEY);

export function newRoomId() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const r = new Uint8Array(12);
  crypto.getRandomValues(r);
  return [...r].map((b) => abc[b % abc.length]).join('');
}

let sbLoad = null;
function loadSupabase() {
  if (window.supabase) return Promise.resolve(window.supabase);
  if (!sbLoad) {
    sbLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('./vendor/supabase-2.58.0.js', import.meta.url).href;
      s.onload = () => resolve(window.supabase);
      s.onerror = () => reject(new Error('supabase 라이브러리를 불러오지 못함'));
      document.head.appendChild(s);
    });
  }
  return sbLoad;
}

class LocalTransport {
  async open(room, onMsg) {
    this.ch = new BroadcastChannel('kfi-room-' + room);
    this.ch.onmessage = (e) => onMsg(e.data);
  }
  send(m) { this.ch && this.ch.postMessage(m); }
  close() { try { this.ch && this.ch.close(); } catch (e) { /* 무시 */ } this.ch = null; }
}

class SupabaseTransport {
  async open(room, onMsg, onState) {
    const sb = await loadSupabase();
    this.client = sb.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false }, realtime: { params: { eventsPerSecond: 20 } } });
    this.ch = this.client.channel('kfi-room-' + room, { config: { broadcast: { self: false, ack: false } } });
    this.ch.on('broadcast', { event: 'm' }, ({ payload }) => onMsg(payload));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('연결 시간 초과')), 12000);
      this.ch.subscribe((status) => {
        onState && onState(status);
        if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timer); reject(new Error(status)); }
      });
    });
  }
  send(m) { this.ch && this.ch.send({ type: 'broadcast', event: 'm', payload: m }); }
  close() { try { this.client && this.ch && this.client.removeChannel(this.ch); } catch (e) { /* 무시 */ } this.ch = this.client = null; }
}

const transportFor = (kind) => (kind === 'supabase' ? new SupabaseTransport() : new LocalTransport());

// ---------------------------------------------------------------- 통역하는 쪽
export class ShareHost {
  constructor({ getSnapshot, onViewers }) {
    this.getSnapshot = getSnapshot; // () => { entries, state }
    this.onViewers = onViewers;
    this.viewers = new Map();
    this.room = null;
    this.kind = null;
  }
  get active() { return !!this.room; }

  async start(kind) {
    this.stop();
    const room = newRoomId();
    const tr = transportFor(kind);
    try { await tr.open(room, (m) => this._onMsg(m)); } catch (e) { tr.close(); throw e; }
    this.kind = kind;
    this.room = room;
    this.tr = tr;
    this.pulse = setInterval(() => {
      const now = Date.now();
      for (const [v, ts] of this.viewers) if (now - ts > 15000) this.viewers.delete(v);
      this.onViewers(this.viewers.size);
      this.send({ t: 'state', state: this.getSnapshot().state });
    }, 5000);
    return this.room;
  }

  _onMsg(m) {
    if (!m || m.t !== 'join' || !m.v) return;
    const isNew = !this.viewers.has(m.v);
    this.viewers.set(m.v, Date.now());
    if (isNew) this.onViewers(this.viewers.size);
    if (m.first) this.send({ t: 'snapshot', ...this.getSnapshot() });
  }

  send(m) { if (this.tr) this.tr.send(m); }
  entry(e) { this.send({ t: 'entry', e: publicEntry(e) }); }

  stop() {
    if (!this.tr) return;
    this.send({ t: 'end' });
    clearInterval(this.pulse);
    const tr = this.tr;
    setTimeout(() => tr.close(), 300);
    this.tr = null;
    this.room = null;
    this.viewers.clear();
    this.onViewers(0);
  }
}

// 보내는 항목: 화면 표시에 필요한 것만(키·설정 등은 절대 보내지 않음)
export const publicEntry = (e) => ({ id: e.id, src: e.src, tgt: e.tgt, orig: e.orig, trans: e.trans, ok: e.ok, pair: e.pair, time: e.time });

// ---------------------------------------------------------------- 보는 쪽
export class ShareViewer {
  constructor({ onEntry, onState, onStatus }) {
    this.cb = { onEntry, onState, onStatus };
    this.id = newRoomId();
  }

  async open(room, kind) {
    this.tr = transportFor(kind);
    this.last = 0;
    await this.tr.open(room, (m) => this._onMsg(m));
    this.tr.send({ t: 'join', v: this.id, first: true });
    this.cb.onStatus('wait');
    this.pulse = setInterval(() => {
      this.tr.send({ t: 'join', v: this.id, first: !this.last });
      if (this.last && Date.now() - this.last > 20000) this.cb.onStatus('lost');
    }, 5000);
  }

  _onMsg(m) {
    if (!m) return;
    if (m.t === 'end') { this.cb.onStatus('ended'); return; }
    this.last = Date.now();
    if (m.t === 'state') { this.cb.onState(m.state); this.cb.onStatus('live'); }
    if (m.t === 'entry') { this.cb.onEntry(m.e); this.cb.onStatus('live'); }
    if (m.t === 'snapshot') {
      if (m.state) this.cb.onState(m.state);
      for (const e of m.entries || []) this.cb.onEntry(e);
      this.cb.onStatus('live');
    }
  }

  close() { clearInterval(this.pulse); if (this.tr) this.tr.close(); }
}
