import { Interpreter, situationWarning } from './engine.js';
import { freeRecognitionSupported } from './free.js';
import { applyStatic, defaultUiLang, langName, setUiLang, t, UI_LANGS, uiLang } from './i18n.js';
import { lang, LANGS } from './langs.js';
import { OpenAIClient } from './openai.js';
import { glossaryKeywords, glossaryText, parseScript, ScriptTracker } from './script.js';
import { publicEntry, ShareHost, ShareViewer, supabaseConfigured } from './share.js';
import { SITUATIONS } from './situations.js';
import * as store from './store.js';
import { Speaker, VOICES } from './tts.js';

export const VERSION = 'web v1.6';
const $ = (id) => document.getElementById(id);
const MAX_ROWS = 150;
const params = new URLSearchParams(location.search);
const VIEW_ROOM = (params.get('view') || '').replace(/[^a-z0-9]/g, '').slice(0, 32);
const IS_VIEWER = !!VIEW_ROOM;
const VIEW_VIA = params.get('via') === 'local' ? 'local' : 'supabase';
const VIEW_SHOW = LANGS[params.get('show')] ? params.get('show') : '';
let viewPicked = false; // 보는 사람이 직접 ⤢를 누르면 링크 지정보다 우선
let shareShow = 'both';

// ---------------------------------------------------------------- 상태
const VIEWER_KEY = 'kfi.viewer';
function loadViewerSettings() {
  let v = { fontSize: 28, layout: 'auto', view: 'both', flipTop: false, uiLang: '', readLeft: false, readRight: false,
    left: 'ko', right: 'ru', situation: 'daily', note: '', mode: 'free', speaking: 'auto' };
  try { Object.assign(v, JSON.parse(localStorage.getItem(VIEWER_KEY) || '{}')); } catch (e) { /* 무시 */ }
  return v;
}
let s = IS_VIEWER ? loadViewerSettings() : store.loadSettings();
let key = IS_VIEWER ? '' : store.loadKey();
const base = store.apiBase();
const entries = new Map();
let wakeLock = null;
let speakingCount = 0;
let unmuteTimer = null;
let level = [0, 0, false, 0];
let noticeTimer = null;
let viewerStatus = 'wait';
// 대본 모드
const SCRIPT_KEY = 'kfi.script';
let script = null;      // { id, name, segs:[{i,n,t:{ko,ru}}], terms, langs }
let tracker = null;
let lastUserScroll = 0;
let viewerParts = null; // 보는 쪽: 나눠서 받는 대본 조각
const scriptActive = () => !!(script && s.scriptOn);

function save() {
  if (IS_VIEWER) {
    const keep = (({ fontSize, layout, view, flipTop, uiLang, readLeft, readRight }) => ({ fontSize, layout, view, flipTop, uiLang, readLeft, readRight }))(s);
    try { localStorage.setItem(VIEWER_KEY, JSON.stringify(keep)); } catch (e) { /* 무시 */ }
  } else store.saveSettings(s);
}
setUiLang(s.uiLang || (IS_VIEWER && UI_LANGS[VIEW_SHOW] ? VIEW_SHOW : defaultUiLang()));

// ---------------------------------------------------------------- 엔진·읽기·공유
const engine = new Interpreter({
  onEntry: addEntry,
  onTranslated: setTranslation,
  onInterim: showInterim,
  onStatus: setStatus,
  onLevel: (lv, thr, act) => { level = [lv, thr, act, Date.now()]; },
  onNotice: notice,
  onCost: addCost,
  onStopped: () => { setRunning(false); setStatus('idle', t('stopped')); },
  claim: claimScript,
  asrHint: () => (scriptActive() ? tracker.upcoming(500) : ''),
  asrKeywords: () => (scriptActive() ? [...glossaryKeywords(script.terms, 'a', 40), ...glossaryKeywords(script.terms, 'b', 20)] : []),
  glossary: () => (scriptActive() ? glossaryText(script.terms) : ''),
});
const speaker = new Speaker({
  onStart: (item) => {
    speakingCount++;
    clearTimeout(unmuteTimer);
    if (s.muteWhileSpeaking && !IS_VIEWER) engine.mute(true);
    markSpeaking(item.id, true);
    if (!IS_VIEWER) setStatus('busy', t('reading') + (s.muteWhileSpeaking ? t('micPaused') : ''));
  },
  onEnd: (item) => {
    speakingCount = Math.max(0, speakingCount - 1);
    markSpeaking(item.id, false);
    if (!speakingCount && !IS_VIEWER) unmuteTimer = setTimeout(() => {
      engine.mute(false);
      if (engine.running) setStatus('listening', t('listening'));
    }, 450);
  },
  onNotice: notice,
  onCost: addCost,
});
const share = new ShareHost({
  getSnapshot: () => ({ entries: [...entries.values()].slice(-30).map(publicEntry), state: publicState() }),
  onViewers: (n) => renderShareBar(n),
  onJoin: () => sendScript(),
});
const publicState = () => ({ left: s.left, right: s.right, situation: s.situation, note: s.note,
  scriptOn: scriptActive(), scriptId: script ? script.id : null, cur: tracker ? tracker.cur : -1 });

function applyEngine() {
  if (IS_VIEWER) { speaker.configure(null, s.voice); return; }
  const client = s.mode === 'openai' && key ? new OpenAIClient(key, base) : null;
  engine.configure(s, s.mode === 'openai' ? key : '', base);
  speaker.configure(client, s.voice);
}

// ---------------------------------------------------------------- 화면 그리기
const sideLang = (side) => (side === 'left' ? s.left : s.right);
const sideOf = (e, code) => (e.pair[0] === code ? 'left' : 'right');
const paneBody = (side) => document.querySelector(`.pane-body[data-side="${side}"]`);

function langLabelEl(el, code) {
  el.textContent = langName(code, LANGS);
  if (lang(code).native !== langName(code, LANGS)) {
    const sm = document.createElement('small');
    sm.textContent = ` · ${lang(code).native}`;
    el.appendChild(sm);
  }
}

function render() {
  applyStatic(document);
  document.title = t('title');
  $('uiBtnLbl').textContent = { ko: '한', ru: 'RU', en: 'EN' }[uiLang()];
  document.body.classList.toggle('viewer', IS_VIEWER);
  document.documentElement.style.setProperty('--fs', `${s.fontSize}px`);
  const sit = SITUATIONS[s.situation] || SITUATIONS.daily;
  $('sitBtn').textContent = `${sit.icon} ${t('sit_' + s.situation)}${s.note ? ' · ' + s.note : ''}`;
  $('sitBtn').disabled = IS_VIEWER;
  $('viewerBadge').hidden = !IS_VIEWER;
  for (const side of ['left', 'right']) {
    langLabelEl(document.querySelector(`.pname[data-side="${side}"]`), sideLang(side));
    const rb = document.querySelector(`.read[data-side="${side}"]`);
    const on = side === 'left' ? s.readLeft : s.readRight;
    rb.setAttribute('aria-pressed', String(on));
    rb.textContent = on ? '🔊' : '🔈';
  }
  const warning = situationWarning(s.situation);
  $('warn').hidden = !warning;
  $('warn').textContent = warning ? '⚠ ' + warning : '';

  const free = s.mode !== 'openai' || !key;
  if (!IS_VIEWER && free && s.speaking === 'auto') s.speaking = 'left';
  for (const b of $('speakingBar').querySelectorAll('button[data-v]')) {
    const v = b.dataset.v;
    if (v === 'left') b.textContent = langName(s.left, LANGS);
    if (v === 'right') b.textContent = langName(s.right, LANGS);
    b.disabled = v === 'auto' && free;
    b.title = b.disabled ? t('autoNeedsKey') : '';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(s.speaking === v));
  }
  const panes = $('panes');
  panes.className = `panes ${s.layout} only-${s.view}` + (s.flipTop ? ' flip' : '');
  $('bothBtn').hidden = s.view === 'both';
  $('usage').textContent = s.mode === 'openai' && key ? t('usage', { v: store.monthUsage().toFixed(3) }) : (free ? t('freeMode') : '');
  $('startBtn').textContent = engine.running ? t('stop') : t('start');
  if (!engine.running && !IS_VIEWER && $('statusText').dataset.idle !== '0') $('statusText').textContent = t('ready');
  renderShareBar(share.viewers.size);
  $('scriptBtn').classList.toggle('on', scriptActive());
  renderScriptBar();
  if (!scriptView() && !entries.size) renderEmpty();
}

function renderEmpty() {
  for (const side of ['left', 'right']) {
    const body = paneBody(side);
    if (body.querySelector('.item')) continue;
    body.innerHTML = '';
    const d = document.createElement('div');
    if (IS_VIEWER) {
      d.className = 'placeholder';
      d.textContent = t({ wait: 'viewerWait', lost: 'viewerLost', ended: 'viewerEnded', live: 'viewerWait' }[viewerStatus]);
    } else if (side === 'left') {
      const free = s.mode !== 'openai' || !key;
      d.className = 'welcome';
      d.innerHTML = `<h2>${t('welcomeTitle')}</h2><p>${t('welcomeBody')}</p><ol>
        <li>${t('welcomeStep1')}</li><li>${t('welcomeStep2', { sit: t('sit_' + s.situation) })}</li><li>${t('welcomeStep3')}</li></ol>
        ${free ? `<p class="hint">${t('welcomeFree')}${freeRecognitionSupported() ? '' : '<br><b>' + t('welcomeNoFree') + '</b>'}</p>
        <div class="row"><button class="primary" id="wKey">${t('welcomeKeyBtn')}</button></div>`
        : `<p class="hint">${t('welcomeOpenai')}</p>`}`;
    } else {
      d.className = 'placeholder';
      d.textContent = '…';
    }
    body.appendChild(d);
  }
  const k = $('wKey');
  if (k) k.onclick = openSettings;
}

function makeItem(isSrc, code) {
  const it = document.createElement('div');
  it.className = 'item ' + (isSrc ? 'src' : 'trans');
  it.innerHTML = '<div class="cap"></div><div class="txt"></div>';
  it.querySelector('.cap').textContent = isSrc ? t('original') : `${t('ai')} · ${t('translating')}`;
  return it;
}

function clearEmpty() {
  document.querySelectorAll('.pane-body .welcome, .pane-body .placeholder').forEach((x) => x.remove());
}

function addEntry(e) {
  clearEmpty();
  const follow = scriptView() ? { left: false, right: false } : { left: atBottom('left'), right: atBottom('right') };
  const srcSide = sideOf(e, e.src);
  const trSide = srcSide === 'left' ? 'right' : 'left';
  const src = makeItem(true, e.src);
  src.querySelector('.txt').textContent = e.orig;
  const tr = makeItem(false, e.tgt);
  tr.querySelector('.txt').textContent = '…';
  tr.addEventListener('dblclick', () => e.ok && speaker.say(e.trans, e.tgt, e.id));
  e.srcEl = src;
  e.trEl = tr;
  if (scriptView() && e.at !== undefined) {
    // 대본에 없는 말: 지금 구간 바로 뒤(앞서 끼운 말들 다음)에 파란 글씨로
    src.querySelector('.cap').textContent = t('scriptAdlib');
    for (const [side, el] of [[srcSide, src], [trSide, tr]]) placeAdlib(paneBody(side), el, e.at);
    revealAdlib(src, tr);
  } else {
    for (const [side, el] of [[srcSide, src], [trSide, tr]]) {
      const body = paneBody(side);
      body.insertBefore(el, body.querySelector('.interim'));
    }
  }
  entries.set(e.id, e);
  while (entries.size > MAX_ROWS) {
    const [id, old] = entries.entries().next().value;
    old.srcEl.remove(); old.trEl.remove();
    entries.delete(id);
  }
  for (const side of ['left', 'right']) if (follow[side]) scrollBottom(side);
  if (share.active) share.entry(e);
}

function setTranslation(e) {
  const tr = e.trEl;
  if (tr) {
    tr.classList.toggle('fail', !e.ok);
    tr.querySelector('.cap').textContent = `${t('ai')}${e.ok ? '' : ' · ' + t('failed')}`;
    tr.querySelector('.txt').textContent = e.trans;
    const side = tr.parentElement && tr.parentElement.dataset.side;
    if (side && !scriptView() && atBottom(side, 240)) scrollBottom(side);
  }
  if (!IS_VIEWER) {
    store.appendHistory({ t: new Date().toISOString(), src: e.src, tgt: e.tgt, orig: e.orig, trans: e.trans, ok: e.ok, ...(e.at !== undefined ? { adlib: true } : {}) });
    if (share.active) share.entry(e);
  }
  const side = sideOf(e, e.tgt);
  const readThis = side === 'left' ? s.readLeft : s.readRight;
  if (e.ok && readThis) speaker.say(e.trans, e.tgt, e.id);
}

// 보는 쪽: 받은 항목을 새로 만들거나 번역만 갱신
function upsertViewerEntry(pe) {
  const cur = entries.get(pe.id);
  if (!cur) {
    const e = { ...pe };
    const trans = e.trans;
    e.trans = null;
    addEntry(e);
    if (trans != null) { e.trans = trans; e.ok = pe.ok; setTranslation(e); }
  } else if (cur.trans !== pe.trans && pe.trans != null) {
    cur.trans = pe.trans; cur.ok = pe.ok;
    setTranslation(cur);
  }
}

function markSpeaking(id, on) {
  const e = entries.get(id);
  if (!e || !e.trEl) return;
  e.trEl.classList.toggle('speaking-now', on);
  e.trEl.querySelector('.cap').textContent = `${t('ai')}${on ? ' · ' + t('readingNow') : ''}`;
}

function showInterim(text, code) {
  if (scriptView()) { if (text) $('statusText').textContent = '… ' + text; return; }
  document.querySelectorAll('.interim').forEach((x) => { if (!text || x.dataset.code !== code) x.remove(); });
  if (!text) return;
  const side = code === s.left ? 'left' : 'right';
  const body = paneBody(side);
  let el = body.querySelector('.interim');
  if (!el) { el = document.createElement('div'); el.className = 'interim'; el.dataset.code = code; body.appendChild(el); }
  el.textContent = text;
  if (atBottom(side, 240)) scrollBottom(side);
}

const atBottom = (side, slack = 60) => { const el = paneBody(side); return el.scrollHeight - el.scrollTop - el.clientHeight < slack; };
const scrollBottom = (side) => requestAnimationFrame(() => { const el = paneBody(side); el.scrollTop = el.scrollHeight; });

function setStatus(state, text) {
  $('dot').className = 'dot ' + ({ listening: 'listening', recognizing: 'busy', busy: 'busy', error: 'error' }[state] || '');
  $('statusText').textContent = text;
  $('statusText').dataset.idle = state === 'idle' ? '1' : '0';
  if (state === 'error') notice(text);
}

function notice(msg) {
  const n = $('notice');
  n.textContent = msg;
  n.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { n.hidden = true; }, 9000);
}

function addCost(usd) {
  if (!usd || IS_VIEWER) return;
  store.addUsage(usd);
  if (s.mode === 'openai' && key) $('usage').textContent = t('usage', { v: store.monthUsage().toFixed(3) });
}

function drawMeter() {
  const c = $('meter'), g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (engine.running && Date.now() - level[3] < 1000) {
    const pos = (v) => Math.max(0, Math.min(c.width, ((20 * Math.log10(Math.max(v, 1e-6)) + 66) / 60) * c.width));
    g.fillStyle = level[2] ? '#16814b' : '#8aa0bd';
    g.fillRect(0, 0, pos(level[0]), c.height);
    g.fillStyle = '#c12a39';
    g.fillRect(pos(level[1]) - 1, 0, 2, c.height);
  }
  requestAnimationFrame(drawMeter);
}

// ---------------------------------------------------------------- 시작·멈춤
function setRunning(on) {
  const b = $('startBtn');
  b.textContent = on ? t('stop') : t('start');
  b.classList.toggle('stop', on);
  if (on) keepAwake(); else if (!share.active) releaseAwake();
}

async function start() {
  if (s.mode === 'openai' && !key) { notice(t('noKey')); openSettings(); return; }
  if ((s.mode !== 'openai' || !key) && !freeRecognitionSupported()) { notice(t('freeUnsupported')); return; }
  applyEngine();
  setRunning(true);
  setStatus('busy', t('openingMic'));
  await engine.start();
}

async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 무시 */ }
}
function releaseAwake() { try { wakeLock && wakeLock.release(); } catch (e) { /* 무시 */ } wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (engine.running || IS_VIEWER || share.active)) { wakeLock = null; keepAwake(); }
});

// ---------------------------------------------------------------- 언어·상황 고르기
function openLangPicker(side) {
  if (IS_VIEWER) return;
  $('langDlgTitle').textContent = side === 'left' ? t('langLeft') : t('langRight');
  const list = $('langList');
  list.innerHTML = '';
  const cur = sideLang(side);
  for (const code of Object.keys(LANGS)) {
    const b = document.createElement('button');
    langLabelEl(b, code);
    if (code === cur) b.className = 'cur';
    b.onclick = () => {
      const other = side === 'left' ? s.right : s.left;
      if (code === other) { [s.left, s.right] = [s.right, s.left]; } else s[side] = code;
      save(); applyEngine(); render();
      if (share.active) share.send({ t: 'state', state: publicState() });
      $('langDlg').close();
    };
    list.appendChild(b);
  }
  $('langDlg').showModal();
}

function openSitPicker() {
  if (IS_VIEWER) return;
  const grid = $('sitList');
  grid.innerHTML = '';
  let chosen = s.situation;
  for (const [k, v] of Object.entries(SITUATIONS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${v.icon} ${t('sit_' + k)}`;
    if (k === chosen) b.className = 'cur';
    b.onclick = () => { chosen = k; grid.querySelectorAll('button').forEach((x) => x.classList.toggle('cur', x === b)); };
    grid.appendChild(b);
  }
  $('noteInput').value = s.note;
  $('sitDone').onclick = () => {
    s.situation = chosen; s.note = $('noteInput').value.trim();
    save(); applyEngine(); render();
    if (share.active) share.send({ t: 'state', state: publicState() });
  };
  $('sitDlg').showModal();
}

// ---------------------------------------------------------------- 공유
function shareLink() {
  return `${location.origin}${location.pathname}?view=${share.room}${share.kind === 'local' ? '&via=local' : ''}`
    + (shareShow !== 'both' ? `&show=${shareShow}` : '');
}

function renderShareDlg() {
  const on = share.active;
  $('shareToggle').textContent = on ? t('shareStop') : t('shareStart');
  $('shareMode').textContent = !supabaseConfigured() ? t('shareNotReady') + ' ' + t('shareLocalOnly')
    : on && share.kind === 'local' ? t('shareLocalOnly') : '';
  const seg = $('shareFor');
  seg.innerHTML = '';
  if (shareShow !== 'both' && shareShow !== s.left && shareShow !== s.right) shareShow = 'both';
  for (const [v, label] of [['both', t('shareBoth')], [s.left, t('shareOnly', { lang: langName(s.left, LANGS) })],
    [s.right, t('shareOnly', { lang: langName(s.right, LANGS) })]]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.show = v;
    b.setAttribute('aria-pressed', String(shareShow === v));
    b.onclick = () => { shareShow = v; renderShareDlg(); };
    seg.appendChild(b);
  }
  $('shareLinkBox').hidden = !on;
  if (on) {
    const link = shareLink();
    $('shareLink').value = link;
    $('shareOpen').href = link;
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(link);
      qr.make();
      $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch (e) { $('qr').textContent = ''; }
  }
}

function renderShareBar(n) {
  const bar = $('shareBar');
  bar.hidden = !share.active;
  if (share.active) bar.textContent = t('shareOn', { n });
}

async function toggleShare() {
  if (share.active) {
    share.stop();
    notice(t('shareEnded'));
    if (!engine.running) releaseAwake();
  } else {
    // 시험용: 이 컴퓨터(localhost)에서만 ?shareVia=local 로 서버 없이 시험
    const forceLocal = ['127.0.0.1', 'localhost'].includes(location.hostname) && params.get('shareVia') === 'local';
    $('shareToggle').disabled = true;
    $('shareMode').textContent = t('shareConnecting');
    try {
      if (supabaseConfigured() && !forceLocal) {
        try { await share.start('supabase'); } catch (e) {
          share.stop();
          await share.start('local');
          notice(t('shareFallbackLocal', { e: e.message || e }));
        }
      } else await share.start('local');
      keepAwake();
    } catch (e) { notice(t('shareFail', { e: e.message || e })); share.stop(); }
    $('shareToggle').disabled = false;
  }
  renderShareDlg();
  renderShareBar(share.viewers.size);
}

// ---------------------------------------------------------------- 대본 모드
const scriptView = () => !!(script && s.scriptOn);
const segSide = (code) => (code === s.left ? 'left' : code === s.right ? 'right' : null);

function setScript(sc, persist = true) {
  script = sc;
  tracker = sc ? new ScriptTracker(sc.segs, sc.langs[0]) : null;
  if (tracker) tracker.cur = Math.max(-1, Math.min(+s.scriptCur || -1, sc.segs.length - 1));
  if (!persist || IS_VIEWER) return true;
  try {
    if (sc) localStorage.setItem(SCRIPT_KEY, JSON.stringify(sc)); else localStorage.removeItem(SCRIPT_KEY);
    return true;
  } catch (e) { notice(t('scriptTooBig')); return false; }
}

function loadSavedScript() {
  if (IS_VIEWER) return;
  try { const j = JSON.parse(localStorage.getItem(SCRIPT_KEY) || 'null'); if (j && j.segs && j.segs.length) setScript(j, false); } catch (e) { /* 무시 */ }
}

// 들은 말이 대본에 있으면 그 구간으로 옮기고 true(번역 생략), 없으면 false(파란 글씨로 AI 번역)
function claimScript(e) {
  if (!scriptActive()) return false;
  e.at = tracker.cur;
  if (e.src !== script.langs[0]) return true; // 대본 모드는 한쪽 방향: 대본 언어(보통 한국어)가 아닌 말은 통역하지 않음
  const m = tracker.match(e.orig);
  if (m) {
    setScriptCur(m.idx, { heard: e.orig });
    const seg = script.segs[m.idx];
    store.appendHistory({ t: new Date().toISOString(), src: e.src, tgt: e.tgt, orig: e.orig, trans: seg.t[e.tgt] || '', ok: true, script: seg.n });
    return true;
  }
  if (e.orig.replace(/[^\p{L}\p{N}]/gu, '').length < 8) return true; // "자", "네", "그러니까" 같은 짧은 군말은 무시
  return false;
}

function setScriptCur(i, { heard = '', broadcast = true } = {}) {
  if (!tracker) return;
  i = Math.max(-1, Math.min(i, script.segs.length - 1));
  const moved = i !== tracker.cur;
  tracker.cur = i;
  if (!IS_VIEWER) { s.scriptCur = i; save(); }
  applyScriptCur(true);
  renderScriptBar();
  if (heard && i >= 0) setStatus('listening', `🎯 ${script.segs[i].n} · ${heard.slice(0, 40)}`);
  if (broadcast && share.active) share.send({ t: 'pos', i });
  // 소리로 읽기가 켜진 언어는 새 구간이 되면 준비된 번역을 읽음
  if (moved && i >= 0 && !IS_VIEWER) {
    for (const code of script.langs) {
      if (code === script.langs[0]) continue;
      const side = segSide(code);
      if (side && (side === 'left' ? s.readLeft : s.readRight) && script.segs[i].t[code]) speaker.say(script.segs[i].t[code], code, 'seg' + i);
    }
  }
}

function scriptTitle() {
  if (!script) return '';
  const first = (script.segs[0] && (script.segs[0].t[uiLang()] || script.segs[0].t[script.langs[0]])) || '';
  const head = first.length <= 60 ? first : first.slice(0, 57) + '…';
  const name = script.name && !/^(downloadfile|script|대본|untitled)/i.test(script.name) ? script.name : '';
  return name && head && !head.includes(name) ? `${name} — ${head}` : (name || head);
}

// 위쪽 막대: 불러온 대본 이름과 진행 위치(누르면 대본 창)
function renderScriptBar() {
  const bar = $('scriptBar');
  bar.hidden = !scriptView();
  if (bar.hidden) return;
  const n = script.segs.length;
  const cur = tracker.cur;
  const pos = cur >= 0 ? `${cur + 1} / ${n}` : `– / ${n}`;
  bar.innerHTML = '<span>📜</span><span class="ttl"></span><span class="pos"></span><span class="prog"><i></i></span>';
  bar.querySelector('.ttl').textContent = scriptTitle();
  bar.querySelector('.pos').textContent = pos;
  bar.querySelector('.prog i').style.width = `${Math.round(((cur + 1) / n) * 100)}%`;
  bar.title = t('scriptTitle');
}

function isHeading(text) { return /^\s*\d+[.)]\s/.test(text) && text.length < 60; }

function renderScriptView() {
  for (const side of ['left', 'right']) {
    const body = paneBody(side);
    body.innerHTML = '';
    body.classList.add('script');
    const code = sideLang(side);
    const frag = document.createDocumentFragment();
    for (const seg of script.segs) {
      const d = document.createElement('div');
      d.className = 'seg' + (isHeading(seg.t[script.langs[0]] || '') ? ' head' : '');
      d.dataset.i = seg.i;
      d.textContent = seg.t[code] || '';
      frag.appendChild(d);
    }
    body.appendChild(frag);
    if (!script.langs.includes(code)) {
      const w = document.createElement('div');
      w.className = 'placeholder';
      w.textContent = t('scriptLangMissing', { lang: langName(code, LANGS) });
      body.prepend(w);
    }
  }
  for (const e of entries.values()) {
    if (e.at === undefined) continue;
    placeAdlib(paneBody(sideOf(e, e.src)), e.srcEl, e.at);
    placeAdlib(paneBody(sideOf(e, e.tgt)), e.trEl, e.at);
  }
  applyScriptCur(false, true);
}

function placeAdlib(body, el, at) {
  el.classList.add('adlib');
  el.dataset.at = at;
  const next = body.querySelector(`.seg[data-i="${at + 1}"]`);
  body.insertBefore(el, next);
}

function revealAdlib(...els) {
  if (Date.now() - lastUserScroll < 6000) return;
  for (const el of els) {
    const body = el.parentElement;
    if (!body) continue;
    const top = el.offsetTop - body.clientHeight * 0.3;
    if (el.offsetTop + el.offsetHeight > body.scrollTop + body.clientHeight - 20) body.scrollTo({ top, behavior: 'smooth' });
  }
}

function applyScriptCur(smooth, force = false) {
  if (!scriptView()) return;
  const cur = tracker.cur;
  for (const side of ['left', 'right']) {
    const body = paneBody(side);
    for (const el of body.children) {
      if (el.classList.contains('seg')) {
        const i = +el.dataset.i;
        el.classList.toggle('past', i < cur);
        el.classList.toggle('now', i === cur);
      } else if (el.classList.contains('adlib')) el.classList.toggle('past', +el.dataset.at < cur);
    }
    if (!force && Date.now() - lastUserScroll < 6000) continue; // 직접 스크롤해 보는 중이면 잠시 그대로
    const target = body.querySelector(`.seg[data-i="${Math.max(0, cur)}"]`);
    if (target) body.scrollTo({ top: Math.max(0, target.offsetTop - body.clientHeight * 0.25), behavior: smooth ? 'smooth' : 'auto' });
  }
}

// 대본 화면 ↔ 일반 화면 바꾸기(받은 말은 그대로 둠)
function rebuildPanes() {
  for (const side of ['left', 'right']) { const b = paneBody(side); b.innerHTML = ''; b.classList.remove('script'); }
  if (scriptView()) { renderScriptView(); return; }
  for (const e of entries.values()) {
    e.srcEl.classList.remove('adlib', 'past');
    e.trEl.classList.remove('adlib', 'past');
    paneBody(sideOf(e, e.src)).appendChild(e.srcEl);
    paneBody(sideOf(e, e.tgt)).appendChild(e.trEl);
  }
  if (!entries.size) renderEmpty();
}

function sendScript() {
  if (!script || !share.active) return;
  const now = Date.now();
  if (sendScript.last && now - sendScript.last < 2000) return; // 여러 명이 동시에 들어와도 한 번만
  sendScript.last = now;
  const PART = 25;
  const parts = Math.ceil(script.segs.length / PART);
  for (let k = 0; k < parts; k++) {
    share.send({ t: 'script', id: script.id, part: k, parts, langs: script.langs,
      segs: script.segs.slice(k * PART, (k + 1) * PART).map((x) => ({ i: x.i, n: x.n, t: x.t })) });
  }
  share.send({ t: 'state', state: publicState() });
}

function viewerScriptMsg(m) {
  if (m.t === 'pos') { if (tracker) setScriptCur(m.i, { broadcast: false }); return; }
  if (m.t !== 'script') return;
  if (script && script.id === m.id) return;
  if (!viewerParts || viewerParts.id !== m.id) viewerParts = { id: m.id, parts: new Array(m.parts), langs: m.langs };
  viewerParts.parts[m.part] = m.segs;
  if (viewerParts.parts.every(Boolean)) {
    setScript({ id: m.id, segs: viewerParts.parts.flat(), terms: [], langs: viewerParts.langs }, false);
    viewerParts = null;
    tracker.cur = s.viewerCur ?? -1;
    rebuildPanes();
    renderScriptBar();
  }
}

function openScriptDlg() {
  renderScriptDlg();
  $('scriptDlg').showModal();
}

function renderScriptDlg() {
  $('scriptInfo').textContent = script
    ? '✅ ' + t('scriptInfo', { name: scriptTitle(), n: script.segs.length, m: script.terms.length, cur: tracker.cur >= 0 ? tracker.cur + 1 : '-' })
    : t('scriptNone');
  $('scriptToggle').textContent = s.scriptOn ? t('scriptOff') : t('scriptOn');
  $('scriptToggle').disabled = !script;
  $('scriptReset').disabled = !script;
  $('scriptClear').disabled = !script;
}

function loadScriptText(text, name) {
  let sc;
  try { sc = parseScript(text); } catch (e) { $('scriptInfo').textContent = t('scriptParseFail'); return; }
  sc.name = (name || '').replace(/\.[^.]+$/, '').slice(0, 60);
  sc.id = Math.random().toString(36).slice(2, 10);
  s.scriptCur = -1;
  if (!setScript(sc)) return;
  const [a, b] = sc.langs;
  if (LANGS[a] && LANGS[b]) { s.left = a; s.right = b; }
  s.scriptOn = true;
  s.speaking = 'left'; // 대본 언어로 고정(자동 언어 구분보다 정확)
  save(); applyEngine(); render(); rebuildPanes();
  if (share.active) { sendScript.last = 0; sendScript(); }
  $('scriptText').value = '';
  renderScriptDlg();
  notice(t('scriptLoaded', { n: sc.segs.length, name: scriptTitle() }));
}

function bindScript() {
  $('scriptBtn').onclick = openScriptDlg;
  $('scriptBar').onclick = () => { if (!IS_VIEWER) openScriptDlg(); };
  $('scriptFile').onchange = async () => {
    const f = $('scriptFile').files[0];
    if (!f) return;
    loadScriptText(await f.text(), f.name);
    $('scriptFile').value = '';
  };
  $('scriptLoad').onclick = () => { if ($('scriptText').value.trim()) loadScriptText($('scriptText').value, ''); };
  $('scriptToggle').onclick = () => {
    s.scriptOn = !s.scriptOn;
    if (s.scriptOn && script && s.left === script.langs[0]) s.speaking = 'left';
    save(); applyEngine(); render(); rebuildPanes(); renderScriptDlg();
    if (share.active) share.send({ t: 'state', state: publicState() });
  };
  $('scriptReset').onclick = () => { setScriptCur(-1); renderScriptDlg(); };
  $('scriptClear').onclick = () => {
    if (!confirm(t('scriptConfirmClear'))) return;
    s.scriptOn = false; s.scriptCur = -1; setScript(null); save(); render(); rebuildPanes(); renderScriptDlg();
    if (share.active) share.send({ t: 'state', state: publicState() });
  };
  // 구간을 누르면 그 위치로(진행자가 바로잡기)
  for (const side of ['left', 'right']) {
    const body = paneBody(side);
    body.addEventListener('click', (ev) => {
      if (IS_VIEWER || !scriptView()) return;
      const seg = ev.target.closest('.seg');
      if (seg) { lastUserScroll = 0; setScriptCur(+seg.dataset.i); }
    });
    for (const ev of ['wheel', 'touchmove']) body.addEventListener(ev, () => { if (scriptView()) lastUserScroll = Date.now(); }, { passive: true });
  }
  // ↓/→/PageDown 다음 구간, ↑/←/PageUp 앞 구간
  document.addEventListener('keydown', (ev) => {
    if (IS_VIEWER || !scriptView() || document.querySelector('dialog[open]')) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
    const k = ev.key;
    if (['ArrowDown', 'ArrowRight', 'PageDown'].includes(k)) { ev.preventDefault(); lastUserScroll = 0; setScriptCur(tracker.cur + 1); }
    if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(k)) { ev.preventDefault(); lastUserScroll = 0; setScriptCur(tracker.cur - 1); }
  });
}

// ---------------------------------------------------------------- 설정 화면
function openSettings() {
  for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === s.mode;
  $('keyInput').value = key;
  $('keyInput').classList.remove('reveal');
  $('keyShow').textContent = t('show');
  $('keyMsg').textContent = key ? t('keyStored', { m: store.maskKey(key) }) : t('keyNone');
  $('keyBox').classList.toggle('hidden', s.mode !== 'openai');
  $('termsInput').value = s.customTerms || '';
  $('voiceSel').value = s.voice;
  $('muteChk').checked = !!s.muteWhileSpeaking;
  $('sensRange').value = s.sensitivity; $('sensOut').textContent = s.sensitivity;
  $('nsChk').checked = !!s.noiseSuppression;
  $('silRange').value = s.silenceSec; $('silOut').textContent = `${s.silenceSec}${t('sec')}`;
  $('fontRange').value = s.fontSize; $('fontOut').textContent = `${s.fontSize}px`;
  $('layoutSel').value = s.layout;
  $('flipChk').checked = !!s.flipTop;
  $('uiLangSel').value = uiLang();
  $('histInfo').textContent = t('histInfo', { n: store.loadHistory().length });
  $('settingsDlg').showModal();
}

function bindSettings() {
  $('voiceSel').innerHTML = VOICES.map((v) => `<option value="${v}">${v}</option>`).join('');
  $('uiLangSel').innerHTML = Object.entries(UI_LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('ver').textContent = VERSION;
  $('uiLangSel').onchange = () => { s.uiLang = $('uiLangSel').value; setUiLang(s.uiLang); save(); render(); openSettings(); };
  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.onchange = () => {
      s.mode = r.value; save();
      $('keyBox').classList.toggle('hidden', s.mode !== 'openai');
      if (engine.running) { engine.stop(); notice(t('modeChanged')); }
      applyEngine(); render();
    };
  }
  $('keyShow').onclick = () => {
    const i = $('keyInput');
    i.classList.toggle('reveal');
    $('keyShow').textContent = i.classList.contains('reveal') ? t('hide') : t('show');
  };
  $('keyPaste').onclick = async () => {
    try {
      const txt = (await navigator.clipboard.readText()).trim();
      if (!txt) throw new Error('empty');
      $('keyInput').value = txt;
      $('keyMsg').textContent = t('keyStored', { m: store.maskKey(txt) }) + ' → ' + t('keyTest') + ' / ' + t('save');
    } catch (e) { $('keyMsg').textContent = t('pasteFail'); $('keyInput').focus(); }
  };
  $('keyTest').onclick = async () => {
    const k = $('keyInput').value.trim();
    if (!k) { $('keyMsg').textContent = t('keyEnter'); return; }
    $('keyMsg').textContent = t('keyTesting');
    try {
      const n = await new OpenAIClient(k, base).check();
      $('keyMsg').textContent = t('keyOk', { n });
    } catch (e) { $('keyMsg').textContent = '✘ ' + (e.userMessage || e.message); }
  };
  $('keySave').onclick = () => {
    const k = $('keyInput').value.trim();
    if (k && !k.startsWith('sk-') && !confirm(t('keyNotSk'))) return;
    store.saveKey(k); key = k;
    $('keyMsg').textContent = k ? t('keySaved', { m: store.maskKey(k) }) : t('keyDeleted');
    applyEngine(); render();
  };
  $('keyDel').onclick = () => {
    if (!confirm(t('keyConfirmDel'))) return;
    store.saveKey(''); key = ''; $('keyInput').value = '';
    $('keyMsg').textContent = t('keyDeleted');
    if (engine.running && s.mode === 'openai') engine.stop();
    applyEngine(); render();
  };
  $('termsInput').onchange = () => { s.customTerms = $('termsInput').value; save(); applyEngine(); };
  $('voiceSel').onchange = () => { s.voice = $('voiceSel').value; save(); applyEngine(); };
  $('muteChk').onchange = () => { s.muteWhileSpeaking = $('muteChk').checked; save(); if (!s.muteWhileSpeaking) engine.mute(false); };
  $('sensRange').oninput = () => { s.sensitivity = +$('sensRange').value; $('sensOut').textContent = s.sensitivity; save(); applyEngine(); };
  $('silRange').oninput = () => { s.silenceSec = +$('silRange').value; $('silOut').textContent = `${s.silenceSec}${t('sec')}`; save(); applyEngine(); };
  $('nsChk').onchange = () => { s.noiseSuppression = $('nsChk').checked; save(); if (engine.running) notice(t('restartToApply')); };
  $('fontRange').oninput = () => { s.fontSize = +$('fontRange').value; $('fontOut').textContent = `${s.fontSize}px`; save(); render(); };
  $('layoutSel').onchange = () => { s.layout = $('layoutSel').value; save(); render(); };
  $('flipChk').onchange = () => { s.flipTop = $('flipChk').checked; save(); render(); };
  $('histDown').onclick = downloadHistory;
  $('histClear').onclick = () => {
    if (!confirm(t('histConfirm'))) return;
    store.clearHistory();
    $('histInfo').textContent = t('histCleared');
  };
}

function downloadHistory() {
  const h = store.loadHistory();
  if (!h.length) { notice(t('histNone')); return; }
  const lines = [t('histHead'), ''];
  for (const r of h) {
    lines.push(`[${new Date(r.t).toLocaleString()}]`, `${t('original')} (${langName(r.src, LANGS)}): ${r.orig}`,
      `${t('ai')} (${langName(r.tgt, LANGS)}): ${r.trans}`, '');
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `interpretation_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.txt`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------- 연결
function toggleRead(side) {
  const k = side === 'left' ? 'readLeft' : 'readRight';
  s[k] = !s[k];
  save(); render();
  if (s[k]) notice(t('readOn', { lang: langName(sideLang(side), LANGS) }));
  else { speaker.stopAll(); notice(t('readOff')); }
}

function bind() {
  $('startBtn').onclick = () => (engine.running ? engine.stop() : start());
  $('settingsBtn').onclick = openSettings;
  $('sitBtn').onclick = openSitPicker;
  $('shareBtn').onclick = () => { renderShareDlg(); $('shareDlg').showModal(); };
  $('shareBar').onclick = () => { renderShareDlg(); $('shareDlg').showModal(); };
  $('shareToggle').onclick = toggleShare;
  $('shareCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('shareLink').value); notice(t('shareCopied')); }
    catch (e) { $('shareLink').select(); }
  };
  document.querySelectorAll('.pname').forEach((b) => { b.onclick = () => openLangPicker(b.dataset.side); });
  document.querySelectorAll('.read').forEach((b) => { b.onclick = () => toggleRead(b.dataset.side); });
  document.querySelectorAll('.expand').forEach((b) => {
    b.onclick = () => { viewPicked = true; s.view = s.view === b.dataset.side ? 'both' : b.dataset.side; save(); render(); };
  });
  $('bothBtn').onclick = () => { viewPicked = true; s.view = 'both'; save(); render(); };
  $('swapBtn').onclick = () => {
    [s.left, s.right] = [s.right, s.left];
    [s.readLeft, s.readRight] = [s.readRight, s.readLeft];
    if (s.speaking !== 'auto') s.speaking = s.speaking === 'left' ? 'right' : 'left';
    save(); applyEngine(); render();
    if (share.active) share.send({ t: 'state', state: publicState() });
  };
  for (const b of $('speakingBar').querySelectorAll('button[data-v]')) {
    b.onclick = () => { if (b.disabled) return; s.speaking = b.dataset.v; save(); applyEngine(); render(); };
  }
  $('uiBtn').onclick = () => {
    const list = $('uiList');
    list.innerHTML = '';
    for (const [k, v] of Object.entries(UI_LANGS)) {
      const b = document.createElement('button');
      b.textContent = v;
      if (k === uiLang()) b.className = 'cur';
      b.onclick = () => { s.uiLang = k; setUiLang(k); save(); render(); $('uiDlg').close(); };
      list.appendChild(b);
    }
    $('uiDlg').showModal();
  };
  $('fontUp').onclick = () => { s.fontSize = Math.min(48, s.fontSize + 2); save(); render(); };
  $('fontDown').onclick = () => { s.fontSize = Math.max(14, s.fontSize - 2); save(); render(); };
  $('settingsDlg').addEventListener('close', () => { applyEngine(); render(); });
  bindSettings();
  bindScript();
}

// ---------------------------------------------------------------- 보기 전용
async function startViewer() {
  const viewer = new ShareViewer({
    onEntry: upsertViewerEntry,
    onOther: viewerScriptMsg,
    onState: (st) => {
      const modeChanged = !!st.scriptOn !== !!s.scriptOn;
      const changed = modeChanged || st.left !== s.left || st.right !== s.right || st.situation !== s.situation || st.note !== s.note;
      Object.assign(s, { left: st.left, right: st.right, situation: st.situation, note: st.note || '', scriptOn: !!st.scriptOn });
      s.viewerCur = st.cur;
      if (st.scriptOn && st.scriptId && (!script || script.id !== st.scriptId) && !viewerParts) window.__viewer && window.__viewer.requestSnapshot();
      if (script && st.scriptId === script.id && tracker.cur !== st.cur) setScriptCur(st.cur, { broadcast: false });
      if (modeChanged || (changed && scriptView())) { render(); rebuildPanes(); }
      if (VIEW_SHOW && !viewPicked) {
        const want = VIEW_SHOW === s.left ? 'left' : VIEW_SHOW === s.right ? 'right' : 'both';
        if (want !== s.view) { s.view = want; render(); return; }
      }
      if (changed) render();
    },
    onStatus: (st) => {
      if (st === viewerStatus) return;
      viewerStatus = st;
      if (st === 'lost') notice(t('viewerLost'));
      if (st === 'ended') notice(t('viewerEnded'));
      if (!entries.size) renderEmpty();
    },
  });
  try { await viewer.open(VIEW_ROOM, VIEW_VIA); keepAwake(); } catch (e) { notice(t('shareFail', { e: e.message || e })); }
  window.__viewer = viewer;
}

loadSavedScript();
bind();
applyEngine();
render();
if (scriptView()) rebuildPanes();
drawMeter();
if (IS_VIEWER) startViewer();
else setStatus('idle', t('ready'));
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  // 새 버전이 들어오면 한 번 새로고침(통역·공유 중에는 끊기지 않게 안내만)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    if (engine.running || share.active) { notice(t('updateReady')); return; }
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
}
// 시험용
window.__app = { engine, speaker, entries, share, get settings() { return s; }, get script() { return script; }, get tracker() { return tracker; }, loadScriptText };
