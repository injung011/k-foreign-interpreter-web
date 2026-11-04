// 이 기기(브라우저)에 저장하는 설정·키·기록. 저장이 막힌 브라우저에서도 동작하도록 모두 try/catch.
import { LANGS } from './langs.js';
import { SITUATIONS } from './situations.js';

const K = { settings: 'kfi.settings', key: 'kfi.openaiKey', history: 'kfi.history', usage: 'kfi.usage' };

export const DEFAULTS = {
  mode: 'free',            // free | openai | member(준비 중)
  left: 'ko',
  right: 'ru',
  speaking: 'auto',        // auto | left | right
  situation: 'daily',
  note: '',
  customTerms: '',
  voice: 'coral',
  readLeft: false,
  readRight: false,
  muteWhileSpeaking: true,
  sensitivity: 5,
  silenceSec: 1.0,
  noiseSuppression: false, // 브라우저 잡음 제거(시끄러운 곳에서만)
  asrV: 2,
  fontSize: 24,
  layout: 'auto',          // auto | stack(위·아래) | side(좌·우)
  view: 'both',            // both | left | right (한 창만 크게)
  flipTop: false,          // 윗창 180° 뒤집기(마주 앉은 대화)
  uiLang: '',              // '' = 기기 언어 따라감
  onboarded: false,
};

const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
const del = (k) => { try { localStorage.removeItem(k); } catch (e) { /* 무시 */ } };

export function loadSettings() {
  let s = { ...DEFAULTS };
  let saved = {};
  try { saved = JSON.parse(get(K.settings) || '{}') || {}; Object.assign(s, saved); } catch (e) { /* 깨진 설정 무시 */ }
  for (const k of Object.keys(s)) if (!(k in DEFAULTS)) delete s[k];
  if (!(saved.asrV >= 2)) { if (+s.silenceSec === 0.8) s.silenceSec = 1.0; s.asrV = 2; } // 옛 기본값(0.8초) → 1.0초
  if (!LANGS[s.left]) s.left = 'ko';
  if (!LANGS[s.right] || s.right === s.left) s.right = s.left === 'ru' ? 'ko' : 'ru';
  if (!SITUATIONS[s.situation]) s.situation = 'daily';
  if (!['free', 'openai', 'member'].includes(s.mode)) s.mode = 'free';
  if (!['auto', 'left', 'right'].includes(s.speaking)) s.speaking = 'auto';
  s.sensitivity = Math.min(10, Math.max(1, +s.sensitivity || 5));
  s.silenceSec = Math.min(2, Math.max(0.4, +s.silenceSec || 1.0));
  s.fontSize = Math.min(48, Math.max(14, +s.fontSize || 24));
  if (s.layout === 'columns') s.layout = 'side';
  if (s.layout === 'cards') s.layout = 'stack';
  if (!['auto', 'stack', 'side'].includes(s.layout)) s.layout = 'auto';
  if (!['both', 'left', 'right'].includes(s.view)) s.view = 'both';
  if (!['', 'ko', 'ru', 'en'].includes(s.uiLang)) s.uiLang = '';
  return s;
}
export const saveSettings = (s) => set(K.settings, JSON.stringify(s));

export const loadKey = () => get(K.key) || '';
export const saveKey = (k) => (k ? set(K.key, k.trim()) : del(K.key));
export const maskKey = (k) => (!k ? '(없음)' : k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : '••••');

// 개발·시험용: 이 컴퓨터(localhost)에서 열었을 때만 ?apiBase=http://127.0.0.1:... 로 가짜 서버 사용.
// 실제 배포 주소에서는 무시한다(악성 링크로 키가 다른 서버로 새는 것 방지). 저장하지 않음.
export function apiBase() {
  const OFFICIAL = 'https://api.openai.com/v1';
  try {
    const local = (h) => h === '127.0.0.1' || h === 'localhost';
    const p = new URLSearchParams(location.search).get('apiBase');
    if (p && local(location.hostname) && local(new URL(p).hostname)) return p;
  } catch (e) { /* 무시 */ }
  return OFFICIAL;
}

const MAX_HISTORY = 500;
export function loadHistory() {
  try { return JSON.parse(get(K.history) || '[]'); } catch (e) { return []; }
}
export function appendHistory(rec) {
  const h = loadHistory();
  h.push(rec);
  set(K.history, JSON.stringify(h.slice(-MAX_HISTORY)));
}
export const clearHistory = () => del(K.history);

const month = () => new Date().toISOString().slice(0, 7);
export function addUsage(usd) {
  let u = {};
  try { u = JSON.parse(get(K.usage) || '{}'); } catch (e) { /* 무시 */ }
  u[month()] = (u[month()] || 0) + usd;
  set(K.usage, JSON.stringify(u));
  return u[month()];
}
export function monthUsage() {
  try { return JSON.parse(get(K.usage) || '{}')[month()] || 0; } catch (e) { return 0; }
}
