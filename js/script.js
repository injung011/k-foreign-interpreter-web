// 대본 모드: 두 언어 대본(구간별 짝)을 읽고, 들은 말이 대본의 어느 구간인지 찾아 따라감.
//
// 대본 형식(순차통역용 프롬프트 결과):
//   [1]
//   KO: 한국어 구간
//   RU: русский сегмент
//   ...
//   용어표
//   하나님 = Бог
//
// 위치 찾기: 글자 두 개 묶음(bigram)이 얼마나 겹치는지로 비교. 대본 전체에 흔한 묶음(…니다, 습니…)은
// 가중치를 낮춰서 "합니다"처럼 어디에나 있는 말로 엉뚱하게 맞지 않게 함. 목사님이 말을 조금 바꾸거나
// 음성 인식이 몇 글자 틀려도 따라갈 수 있음.

const TAG = /^\s*([A-Za-z]{2,3})\s*[:：]\s*(.*)$/;

export function parseScript(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const segs = [];
  const terms = [];
  let cur = null, field = null, inTerms = false;
  const langs = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^[—–-]+\s*계속\s*[—–-]+$/.test(line)) { field = null; continue; }
    if (/^(용어표|용어|глоссарий|glossary)\s*:?$/i.test(line)) { inTerms = true; cur = null; field = null; continue; }
    const num = line.match(/^\[(\d+)\]$/);
    if (num) { inTerms = false; cur = { n: +num[1], t: {} }; segs.push(cur); field = null; continue; }
    if (inTerms) {
      const m = line.match(/^(.+?)\s*=\s*(.+)$/);
      if (m) terms.push({ a: m[1].trim(), b: m[2].trim() });
      continue;
    }
    const tag = cur && line.match(TAG);
    if (tag) {
      field = tag[1].toLowerCase();
      if (!langs.includes(field)) langs.push(field);
      cur.t[field] = tag[2].trim();
      continue;
    }
    if (cur && field) cur.t[field] = (cur.t[field] + ' ' + line).trim(); // 여러 줄로 이어진 구간
  }
  const good = segs.filter((s) => Object.values(s.t).some(Boolean));
  if (!good.length || langs.length < 2) throw new Error('format');
  return { segs: good.map((s, i) => ({ i, n: s.n, t: s.t })), terms, langs: langs.slice(0, 2) };
}

// 성경 장절 약어 → 말로 읽는 형태. "(창 1:26)" → "창세기 1장 26절"
// 목사님은 괄호·약어를 그대로 읽지 않고 "창세기 1장 26절 읽겠습니다"처럼 말하므로, 비교할 때만 풀어서 씀(화면 글자는 그대로).
const BOOKS = {
  창: '창세기', 출: '출애굽기', 레: '레위기', 민: '민수기', 신: '신명기', 수: '여호수아', 삿: '사사기', 룻: '룻기',
  삼상: '사무엘상', 삼하: '사무엘하', 왕상: '열왕기상', 왕하: '열왕기하', 대상: '역대상', 대하: '역대하', 스: '에스라', 느: '느헤미야',
  에: '에스더', 욥: '욥기', 시: '시편', 잠: '잠언', 전: '전도서', 아: '아가', 사: '이사야', 렘: '예레미야', 애: '예레미야애가',
  겔: '에스겔', 단: '다니엘', 호: '호세아', 욜: '요엘', 암: '아모스', 옵: '오바댜', 욘: '요나', 미: '미가', 나: '나훔', 합: '하박국',
  습: '스바냐', 학: '학개', 슥: '스가랴', 말: '말라기', 마: '마태복음', 막: '마가복음', 눅: '누가복음', 요: '요한복음', 행: '사도행전',
  롬: '로마서', 고전: '고린도전서', 고후: '고린도후서', 갈: '갈라디아서', 엡: '에베소서', 빌: '빌립보서', 골: '골로새서',
  살전: '데살로니가전서', 살후: '데살로니가후서', 딤전: '디모데전서', 딤후: '디모데후서', 딛: '디도서', 몬: '빌레몬서', 히: '히브리서',
  약: '야고보서', 벧전: '베드로전서', 벧후: '베드로후서', 요일: '요한일서', 요이: '요한이서', 요삼: '요한삼서', 유: '유다서', 계: '요한계시록',
};
const REF = new RegExp(`\\(?\\s*(?<![가-힣])(${Object.keys(BOOKS).sort((x, y) => y.length - x.length).join('|')})\\s*(\\d+)\\s*:\\s*(\\d+)(?:\\s*[-~–]\\s*(\\d+))?\\s*\\)?`, 'g');
export function expandRefs(text) {
  return String(text || '').replace(REF, (_, b, c, v, v2) => ` ${BOOKS[b]} ${c}${b === '시' ? '편' : '장'} ${v}절${v2 ? ` ${v2}절` : ''} `).replace(/\s+/g, ' ').trim();
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function grams(s) {
  const n = norm(s);
  const out = new Set();
  for (let i = 0; i < n.length - 1; i++) out.add(n.slice(i, i + 2));
  if (n.length === 1) out.add(n);
  return out;
}

export class ScriptTracker {
  constructor(segs, src) {
    this.segs = segs;
    this.src = src;
    this.text = segs.map((s) => (src === 'ko' ? expandRefs(s.t[src]) : s.t[src] || ''));
    this.g = this.text.map((x) => grams(x));
    const df = new Map();
    for (const g of this.g) for (const b of g) df.set(b, (df.get(b) || 0) + 1);
    const N = segs.length;
    this.w = (b) => Math.log((N + 1) / ((df.get(b) || 0) + 0.5)); // 흔할수록 작게, 대본에 없으면 크게
    this.cur = -1;
  }

  // 들은 말 → { idx, cov } 또는 null(대본에 없는 말)
  match(text) {
    const u = grams(text);
    if (u.size < 3) return null;
    let total = 0;
    const wt = new Map();
    for (const b of u) { const w = this.w(b); wt.set(b, w); total += w; }
    const n = this.segs.length;
    const scan = (lo, hi, nearBonus) => {
      let best = null;
      for (let j = lo; j <= hi; j++) {
        const hit = new Set();
        let gotLast = j;
        for (let k = j; k < Math.min(n, j + 3); k++) {
          let own = 0;
          for (const b of u) if (this.g[k].has(b)) { hit.add(b); own += wt.get(b); }
          if (own / total >= 0.18) gotLast = k;
          let cov = 0;
          for (const b of hit) cov += wt.get(b);
          cov /= total;
          const ahead = j - (this.cur + 1);
          const pen = nearBonus ? (ahead > 0 ? ahead * 0.012 : ahead < -1 ? 0.08 + (-ahead) * 0.01 : 0) + (k - j) * 0.04 : (k - j) * 0.04;
          const score = cov - pen;
          if (!best || score > best.score) best = { idx: gotLast, cov, score };
        }
      }
      return best;
    };
    // 바로 지금·다음 구간이면 너그럽게(말을 줄이거나 인식이 틀려도), 조금 먼 곳은 보통, 대본 전체는 엄격하게
    const near = scan(Math.max(0, this.cur - 1), Math.min(n - 1, this.cur + 2), true);
    if (near && near.cov >= 0.3) return near;
    const lo = Math.max(0, this.cur - 3), hi = Math.min(n - 1, this.cur + 15);
    const m = scan(lo, hi, true);
    if (m && m.cov >= 0.42) return m;
    // 가까운 곳에 없으면 대본 전체에서(크게 건너뛰신 경우) — 더 엄격하게
    const g = scan(0, n - 1, false);
    if (g && g.cov >= 0.6) return g;
    return null;
  }

  // 다음에 나올 대본(음성 인식 힌트용)
  upcoming(chars = 500) {
    let out = '';
    for (let k = Math.max(0, this.cur); k < this.segs.length && out.length < chars; k++) out += (out ? ' ' : '') + this.text[k];
    return out.slice(0, chars);
  }
}

// 용어표 → 번역 지시문/인식 힌트
export function glossaryText(terms, max = 80) {
  return terms.slice(0, max).map((x) => `${x.a} = ${x.b}`).join('\n');
}
export function glossaryKeywords(terms, side, max = 60) {
  const out = [];
  for (const x of terms) for (const w of (side === 'a' ? x.a : x.b).split('/')) {
    const v = w.replace(/\(.*?\)/g, '').trim();
    if (v && v.length <= 40 && !out.includes(v)) out.push(v);
  }
  return out.slice(0, max);
}
