import { Interpreter, situationWarning } from './engine.js';
import { freeRecognitionSupported } from './free.js';
import { label, lang, LANGS } from './langs.js';
import { OpenAIClient } from './openai.js';
import { SITUATIONS } from './situations.js';
import * as store from './store.js';
import { Speaker, VOICES } from './tts.js';

export const VERSION = 'web v1.0';
const $ = (id) => document.getElementById(id);
const MAX_ROWS = 150;

let s = store.loadSettings();
let key = store.loadKey();
const base = store.apiBase();
const entries = new Map();
let wakeLock = null;
let speakingCount = 0;
let unmuteTimer = null;
let level = [0, 0, false, 0];
let noticeTimer = null;

// ---------------------------------------------------------------- 엔진·읽기
const engine = new Interpreter({
  onEntry: addEntry,
  onTranslated: setTranslation,
  onInterim: showInterim,
  onStatus: setStatus,
  onLevel: (lv, thr, act) => { level = [lv, thr, act, Date.now()]; },
  onNotice: notice,
  onCost: addCost,
  onStopped: () => { setRunning(false); setStatus('idle', '멈춤'); },
});
const speaker = new Speaker({
  onStart: (item) => {
    speakingCount++;
    clearTimeout(unmuteTimer);
    if (s.muteWhileSpeaking) engine.mute(true);
    markSpeaking(item.id, true);
    setStatus('busy', '통역을 읽는 중…' + (s.muteWhileSpeaking ? ' (마이크 잠시 멈춤)' : ''));
  },
  onEnd: (item) => {
    speakingCount = Math.max(0, speakingCount - 1);
    markSpeaking(item.id, false);
    if (!speakingCount) unmuteTimer = setTimeout(() => {
      engine.mute(false);
      if (engine.running) setStatus('listening', '듣는 중');
    }, 450);
  },
  onNotice: notice,
  onCost: addCost,
});

function applyEngine() {
  const client = s.mode === 'openai' && key ? new OpenAIClient(key, base) : null;
  engine.configure(s, s.mode === 'openai' ? key : '', base);
  speaker.configure(client, s.voice);
}

function save() { store.saveSettings(s); }

// ---------------------------------------------------------------- 화면 그리기
function render() {
  document.documentElement.style.setProperty('--fs', `${s.fontSize}px`);
  const sit = SITUATIONS[s.situation];
  $('sitBtn').textContent = `${sit.icon} ${sit.name}${s.note ? ' · ' + s.note : ''}`;
  for (const [id, code] of [['leftBtn', s.left], ['rightBtn', s.right]]) {
    const b = $(id);
    b.textContent = lang(code).name;
    if (lang(code).native !== lang(code).name) {
      const sm = document.createElement('small');
      sm.textContent = ` · ${lang(code).native}`;   // 좁은 휴대폰에서는 CSS로 숨김
      b.appendChild(sm);
    }
    b.title = label(code);
  }
  setPressed($('readLeft'), s.readLeft);
  setPressed($('readRight'), s.readRight);
  const warning = situationWarning(s.situation);
  $('warn').hidden = !warning;
  $('warn').textContent = warning ? '⚠ ' + warning : '';

  const free = s.mode !== 'openai' || !key;
  if (free && s.speaking === 'auto') s.speaking = 'left';
  for (const b of $('speakingBar').querySelectorAll('button')) {
    const v = b.dataset.v;
    if (v === 'left') b.textContent = lang(s.left).name;
    if (v === 'right') b.textContent = lang(s.right).name;
    b.disabled = v === 'auto' && free;
    b.title = b.disabled ? '자동 감지는 OpenAI 키 모드에서만 됩니다' : '';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(s.speaking === v));
  }
  const sub = $('subs');
  sub.classList.remove('auto', 'cards', 'columns');
  sub.classList.add(s.layout);
  $('usage').textContent = s.mode === 'openai' && key ? `이번 달 약 $${store.monthUsage().toFixed(3)}` : (free ? '무료 모드' : '');
  if (!entries.size) renderWelcome();
}

function setPressed(btn, on) { btn.setAttribute('aria-pressed', String(on)); btn.textContent = on ? '🔊' : '🔈'; }

function renderWelcome() {
  const sub = $('subs');
  if (sub.querySelector('.entry')) return;
  const free = s.mode !== 'openai' || !key;
  sub.innerHTML = '';
  const w = document.createElement('div');
  w.className = 'welcome';
  w.innerHTML = `
    <h2>통역 자막</h2>
    <p>말하면 <b>원문</b>(말한 그대로)과 <b>AI 통역</b>이 함께 나옵니다.</p>
    <ol>
      <li>위에서 <b>두 언어</b>를 고르세요. (지금: ${lang(s.left).name} ↔ ${lang(s.right).name})</li>
      <li>맨 위 버튼으로 <b>상황</b>을 고르세요. (지금: ${SITUATIONS[s.situation].name})</li>
      <li>아래 <b>▶ 통역 시작</b>을 누르고 말씀하세요.</li>
    </ol>
    ${free
      ? `<p class="hint">지금은 <b>무료 모드</b>입니다. 말하는 언어를 직접 눌러 바꿔야 하고 정확도가 낮습니다.
         ${freeRecognitionSupported() ? '' : '<br><b>이 브라우저는 무료 음성 인식을 지원하지 않습니다. 크롬을 쓰거나 OpenAI 키를 넣으세요.</b>'}</p>
         <div class="row"><button class="primary" id="wKey">OpenAI 키 넣기 (더 정확)</button></div>`
      : '<p class="hint">OpenAI 모드: 두 언어를 자동으로 알아듣고 상황에 맞게 통역합니다.</p>'}`;
  sub.appendChild(w);
  const k = $('wKey');
  if (k) k.onclick = openSettings;
}

function addEntry(e) {
  const sub = $('subs');
  const w = sub.querySelector('.welcome');
  if (w) w.remove();
  const follow = atBottom();
  const el = document.createElement('div');
  el.className = 'entry ' + (e.src === s.left ? 'src-left' : 'src-right');
  const srcSide = e.pair[0] === e.src ? 'left' : 'right';
  for (const side of ['left', 'right']) {
    const isSrc = side === srcSide;
    const code = side === 'left' ? e.pair[0] : e.pair[1];
    const c = document.createElement('div');
    c.className = `cell ${side} ${isSrc ? 'src' : 'trans'}`;
    c.innerHTML = '<div class="cap"></div><div class="txt"></div>';
    c.querySelector('.cap').textContent = isSrc ? `원문 · ${lang(code).name}` : `AI 통역 · ${lang(code).name} · 번역 중…`;
    c.querySelector('.txt').textContent = isSrc ? e.orig : '…';
    if (!isSrc) c.addEventListener('dblclick', () => e.ok && speaker.say(e.trans, e.tgt, e.id));
    el.appendChild(c);
  }
  e.el = el;
  entries.set(e.id, e);
  const interim = sub.querySelector('.interim');
  sub.insertBefore(el, interim);
  while (entries.size > MAX_ROWS) {
    const [id, old] = entries.entries().next().value;
    old.el.remove();
    entries.delete(id);
  }
  if (follow) scrollBottom();
}

function setTranslation(e) {
  const cell = e.el && e.el.querySelector('.cell.trans');
  if (cell) {
    cell.classList.toggle('fail', !e.ok);
    cell.querySelector('.cap').textContent = `AI 통역 · ${lang(e.tgt).name}${e.ok ? '' : ' · 실패'}`;
    cell.querySelector('.txt').textContent = e.trans;
    if (atBottom(200)) scrollBottom();
  }
  store.appendHistory({ t: new Date().toISOString(), src: e.src, tgt: e.tgt, orig: e.orig, trans: e.trans, ok: e.ok });
  const readThis = e.tgt === s.left ? s.readLeft : e.tgt === s.right ? s.readRight : false;
  if (e.ok && readThis) speaker.say(e.trans, e.tgt, e.id);
}

function markSpeaking(id, on) {
  const e = entries.get(id);
  const cell = e && e.el && e.el.querySelector('.cell.trans');
  if (!cell) return;
  cell.classList.toggle('speaking-now', on);
  cell.querySelector('.cap').textContent = `AI 통역 · ${lang(e.tgt).name}${on ? ' · 🔊 읽는 중' : ''}`;
}

function showInterim(text, code) {
  const sub = $('subs');
  let el = sub.querySelector('.interim');
  if (!text) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.className = 'interim'; sub.appendChild(el); }
  el.textContent = `${lang(code).name}: ${text}`;
  if (atBottom(200)) scrollBottom();
}

const atBottom = (slack = 60) => { const el = $('subs'); return el.scrollHeight - el.scrollTop - el.clientHeight < slack; };
const scrollBottom = () => requestAnimationFrame(() => { const el = $('subs'); el.scrollTop = el.scrollHeight; });

function setStatus(state, text) {
  $('dot').className = 'dot ' + ({ listening: 'listening', recognizing: 'busy', busy: 'busy', error: 'error' }[state] || '');
  $('statusText').textContent = text;
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
  if (!usd) return;
  store.addUsage(usd);
  if (s.mode === 'openai' && key) $('usage').textContent = `이번 달 약 $${store.monthUsage().toFixed(3)}`;
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
  b.textContent = on ? '■ 멈춤' : '▶ 통역 시작';
  b.classList.toggle('stop', on);
  if (on) keepAwake(); else releaseAwake();
}

async function start() {
  if (s.mode === 'openai' && !key) { notice('OpenAI 키가 없습니다. 설정에서 키를 넣거나 무료 모드를 고르세요.'); openSettings(); return; }
  if ((s.mode !== 'openai' || !key) && !freeRecognitionSupported()) {
    notice('이 브라우저는 무료 음성 인식을 지원하지 않습니다. 크롬을 쓰거나 설정에서 OpenAI 키를 넣으세요.');
    return;
  }
  applyEngine();
  setRunning(true);
  setStatus('busy', '마이크 여는 중…');
  await engine.start();
}

async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 무시 */ }
}
function releaseAwake() { try { wakeLock && wakeLock.release(); } catch (e) { /* 무시 */ } wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && engine.running) keepAwake();
});

// ---------------------------------------------------------------- 언어·상황 고르기
function openLangPicker(side) {
  $('langDlgTitle').textContent = side === 'left' ? '왼쪽 언어' : '오른쪽 언어';
  const list = $('langList');
  list.innerHTML = '';
  const cur = side === 'left' ? s.left : s.right;
  for (const code of Object.keys(LANGS)) {
    const b = document.createElement('button');
    b.textContent = label(code);
    if (code === cur) b.className = 'cur';
    b.onclick = () => {
      const other = side === 'left' ? s.right : s.left;
      if (code === other) { [s.left, s.right] = [s.right, s.left]; } else s[side] = code;
      save(); applyEngine(); render();
      $('langDlg').close();
    };
    list.appendChild(b);
  }
  $('langDlg').showModal();
}

function openSitPicker() {
  const grid = $('sitList');
  grid.innerHTML = '';
  let chosen = s.situation;
  for (const [k, v] of Object.entries(SITUATIONS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${v.icon} ${v.name}`;
    if (k === chosen) b.className = 'cur';
    b.onclick = () => { chosen = k; grid.querySelectorAll('button').forEach((x) => x.classList.toggle('cur', x === b)); };
    grid.appendChild(b);
  }
  $('noteInput').value = s.note;
  $('sitDone').onclick = () => { s.situation = chosen; s.note = $('noteInput').value.trim(); save(); applyEngine(); render(); };
  $('sitDlg').showModal();
}

// ---------------------------------------------------------------- 설정 화면
function openSettings() {
  for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === s.mode;
  $('keyInput').value = key;
  $('keyMsg').textContent = key ? `저장된 키: ${store.maskKey(key)}` : '저장된 키가 없습니다.';
  $('keyBox').classList.toggle('hidden', s.mode !== 'openai');
  $('termsInput').value = s.customTerms;
  $('voiceSel').value = s.voice;
  $('muteChk').checked = s.muteWhileSpeaking;
  $('sensRange').value = s.sensitivity; $('sensOut').textContent = s.sensitivity;
  $('silRange').value = s.silenceSec; $('silOut').textContent = `${s.silenceSec}초`;
  $('fontRange').value = s.fontSize; $('fontOut').textContent = `${s.fontSize}px`;
  $('layoutSel').value = s.layout;
  $('histInfo').textContent = `이 기기에 저장된 통역 ${store.loadHistory().length}건 (최근 500건까지 보관)`;
  $('settingsDlg').showModal();
}

function bindSettings() {
  $('voiceSel').innerHTML = VOICES.map((v) => `<option value="${v}">${v}</option>`).join('');
  $('ver').textContent = VERSION;
  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.onchange = () => {
      s.mode = r.value; save();
      $('keyBox').classList.toggle('hidden', s.mode !== 'openai');
      if (engine.running) { engine.stop(); notice('연결 방식이 바뀌어 통역을 멈췄습니다. 다시 시작하세요.'); }
      applyEngine(); render();
    };
  }
  $('keyShow').onclick = () => {
    const i = $('keyInput');
    i.type = i.type === 'password' ? 'text' : 'password';
    $('keyShow').textContent = i.type === 'password' ? '보기' : '숨기기';
  };
  $('keyTest').onclick = async () => {
    const k = $('keyInput').value.trim();
    if (!k) { $('keyMsg').textContent = '키를 입력하세요.'; return; }
    $('keyMsg').textContent = '연결 시험 중…';
    try {
      const n = await new OpenAIClient(k, base).check();
      $('keyMsg').textContent = `✔ 연결 성공 (사용 가능한 모델 ${n}개). ‘저장’을 누르세요.`;
    } catch (e) { $('keyMsg').textContent = '✘ ' + (e.userMessage || e.message); }
  };
  $('keySave').onclick = () => {
    const k = $('keyInput').value.trim();
    if (k && !k.startsWith('sk-') && !confirm('OpenAI 키는 보통 sk-로 시작합니다. 그래도 저장할까요?')) return;
    store.saveKey(k); key = k;
    $('keyMsg').textContent = k ? `저장했습니다: ${store.maskKey(k)}` : '키를 지웠습니다.';
    applyEngine(); render();
  };
  $('keyDel').onclick = () => {
    if (!confirm('이 기기에 저장된 OpenAI 키를 지울까요?')) return;
    store.saveKey(''); key = ''; $('keyInput').value = '';
    $('keyMsg').textContent = '키를 지웠습니다.';
    if (engine.running && s.mode === 'openai') engine.stop();
    applyEngine(); render();
  };
  $('termsInput').onchange = () => { s.customTerms = $('termsInput').value; save(); applyEngine(); };
  $('voiceSel').onchange = () => { s.voice = $('voiceSel').value; save(); applyEngine(); };
  $('muteChk').onchange = () => { s.muteWhileSpeaking = $('muteChk').checked; save(); if (!s.muteWhileSpeaking) engine.mute(false); };
  $('sensRange').oninput = () => { s.sensitivity = +$('sensRange').value; $('sensOut').textContent = s.sensitivity; save(); applyEngine(); };
  $('silRange').oninput = () => { s.silenceSec = +$('silRange').value; $('silOut').textContent = `${s.silenceSec}초`; save(); applyEngine(); };
  $('fontRange').oninput = () => { s.fontSize = +$('fontRange').value; $('fontOut').textContent = `${s.fontSize}px`; save(); render(); };
  $('layoutSel').onchange = () => { s.layout = $('layoutSel').value; save(); render(); };
  $('histDown').onclick = downloadHistory;
  $('histClear').onclick = () => {
    if (!confirm('이 기기에 저장된 통역 기록을 모두 지울까요?')) return;
    store.clearHistory();
    $('histInfo').textContent = '기록을 지웠습니다.';
  };
}

function downloadHistory() {
  const h = store.loadHistory();
  if (!h.length) { notice('저장된 통역 기록이 없습니다.'); return; }
  const lines = ['통역 기록 (원문 = 말한 그대로, AI 통역 = 인공지능 번역)', ''];
  for (const r of h) {
    const t = new Date(r.t);
    lines.push(`[${t.toLocaleString('ko-KR')}]`, `원문(${lang(r.src).name}): ${r.orig}`, `AI 통역(${lang(r.tgt).name}): ${r.trans}`, '');
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `통역기록_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.txt`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------- 연결
function bind() {
  $('startBtn').onclick = () => (engine.running ? engine.stop() : start());
  $('settingsBtn').onclick = openSettings;
  $('sitBtn').onclick = openSitPicker;
  $('leftBtn').onclick = () => openLangPicker('left');
  $('rightBtn').onclick = () => openLangPicker('right');
  $('swapBtn').onclick = () => {
    [s.left, s.right] = [s.right, s.left];
    [s.readLeft, s.readRight] = [s.readRight, s.readLeft];
    if (s.speaking !== 'auto') s.speaking = s.speaking === 'left' ? 'right' : 'left';
    save(); applyEngine(); render();
  };
  $('readLeft').onclick = () => toggleRead('readLeft');
  $('readRight').onclick = () => toggleRead('readRight');
  for (const b of $('speakingBar').querySelectorAll('button')) {
    b.onclick = () => { if (b.disabled) return; s.speaking = b.dataset.v; save(); applyEngine(); render(); };
  }
  $('settingsDlg').addEventListener('close', () => { applyEngine(); render(); });
  bindSettings();
}

function toggleRead(k) {
  s[k] = !s[k];
  save(); render();
  const code = k === 'readLeft' ? s.left : s.right;
  if (s[k]) notice(`${lang(code).name}로 나온 AI 통역을 소리로 읽습니다. 다시 누르면 꺼집니다.`);
  else { speaker.stopAll(); notice('읽기를 껐습니다.'); }
}

bind();
applyEngine();
render();
drawMeter();
setStatus('idle', '준비 — ▶ 통역 시작을 누르세요');
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// 시험용으로 노출
window.__app = { engine, speaker, entries, get settings() { return s; } };
