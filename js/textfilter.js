// 인식 결과 정리: 글자 체계로 언어 확인, 음성인식 환각 문구 제거, 번역 결과 검사
import { lang } from './langs.js';

const RE = {
  hangul: /[가-힣ㄱ-ㆎ]/g,
  cyrillic: /[Ѐ-ӿ]/g,
  latin: /[A-Za-zÀ-ɏḀ-ỿ]/g,
  han: /[一-鿿㐀-䶿]/g,
  kana: /[぀-ヿ]/g,
  thai: /[฀-๿]/g,
};
const PUNCT = /[\s.,!?…·\-–—"'«»()[\]:;~]+/g;

export const normalize = (t) => (t || '').replace(PUNCT, '').toLowerCase();

export function scriptCounts(text) {
  const out = {};
  for (const [k, re] of Object.entries(RE)) out[k] = ((text || '').match(re) || []).length;
  return out;
}

export function dominantScript(text) {
  const c = scriptCounts(text);
  const max = Math.max(...Object.values(c));
  if (max === 0) return null;
  if (c.kana && c.kana + c.han >= max) return 'kana';
  return Object.keys(c).find((k) => c[k] === max);
}

export function matchesLang(text, code) {
  const s = lang(code).script;
  const d = dominantScript(text);
  return s === 'kana' ? d === 'kana' || d === 'han' : d === s;
}

// 후보 중 글자 체계가 맞는 언어가 하나뿐이면 그 언어
export function langFromText(text, candidates) {
  const hits = candidates.filter((c) => matchesLang(text, c));
  return hits.length === 1 ? hits[0] : null;
}

// 번역 결과가 원문 그대로거나 목표 언어 글자가 너무 적으면 false
export function looksTranslated(original, out, tgt) {
  if (!out || normalize(out) === normalize(original)) return false;
  const s = lang(tgt).script;
  const c = scriptCounts(out);
  const n = s === 'kana' || s === 'han' ? c.kana + c.han : c[s] || 0;
  return n >= Math.max(1, Math.floor(normalize(out).length / 5));
}

// 무음·잡음에서 음성인식이 지어내는 문구(동영상 자막 학습 흔적)
const HALLUCINATIONS = [
  '시청해주셔서감사합니다', '구독과좋아요', '구독좋아요', '다음영상에서만나요', '자막제공', 'mbc뉴스',
  'продолжениеследует', 'субтитрысделал', 'редакторсубтитров', 'dimatorzok', 'спасибозапросмотр',
  'thankyouforwatching', 'pleasesubscribe', 'subtitlesby', 'amaraorg',
];

export function isHallucination(text) {
  const n = normalize(text);
  if (!n) return true;
  for (const p of HALLUCINATIONS) if (n.includes(p) && n.length <= p.length + 12) return true;
  if (n.length >= 4 && new Set(n).size <= 2) return true;
  return false;
}

export function clean(text) {
  let t = (text || '').replace(/\s+/g, ' ').trim();
  // \b는 한글을 단어로 보지 않으므로 공백 기준 경계 사용
  const rep = /(?<!\S)(\S+(?:\s+\S+){0,3}?)(?:\s+\1){3,}(?!\S)/gu;
  let prev;
  do { prev = t; t = t.replace(rep, '$1'); } while (t !== prev);
  return t;
}
