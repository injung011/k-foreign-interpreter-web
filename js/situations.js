// 사용 상황별 번역 지시와 음성 인식 힌트
import { lang } from './langs.js';

export const SITUATIONS = {
  church: {
    name: '교회', icon: '⛪',
    rules: [
      'Setting: a Protestant church gathering (worship, testimony, fellowship).',
      'Church titles: "OOO 형제/자매" (Korean), "брат OOO / сестра OOO" (Russian), "Brother/Sister OOO" are titles of fellow believers, not family members; use the equivalent church title.',
      'Church vocabulary: 목사님=pastor/пастор, 전도사님=evangelist/евангелист, 장로님=elder/пресвитер, 집사님=deacon/диакон, 성도(님)들=brothers and sisters/братья и сёстры, 교제=fellowship/общение, 예배=worship service/богослужение, 간증=testimony/свидетельство, 은혜=grace/благодать, 찬양=praise/прославление, 말씀=the Word/Слово.',
    ],
    keywords: ['교제', '형제', '자매', '목사님', '전도사님', '장로님', '집사님', '성도', '예배', '간증', '찬양', '말씀', '은혜', '성령', '하나님', '예수님', '아멘',
      'брат', 'сестра', 'пастор', 'общение', 'богослужение', 'свидетельство', 'благодать', 'Святой Дух', 'Иисус Христос', 'аминь',
      'Brother', 'Sister', 'Pastor', 'fellowship', 'worship', 'testimony', 'grace', 'Holy Spirit', 'Jesus Christ', 'amen'],
  },
  hospital: {
    name: '병원', icon: '🏥',
    warning: '의료 통역 주의: AI 통역은 틀릴 수 있습니다. 진단·처방·수술 동의 등 중요한 내용은 반드시 의료진·전문 통역으로 확인하세요.',
    rules: [
      'Setting: a medical consultation between patient and medical staff.',
      'Translate medical terms precisely. NEVER change numbers, doses, units, times, left/right, or negations.',
      'If a medical term is ambiguous, add the original term in parentheses.',
      'Use calm, clear, polite language suitable for patients.',
    ],
    keywords: ['진료', '증상', '처방', '알레르기', '혈압', '체온', '통증', '복용', '검사', '수술', '입원', '응급',
      'симптомы', 'рецепт', 'аллергия', 'давление', 'температура', 'боль', 'анализ', 'операция',
      'symptoms', 'prescription', 'allergy', 'blood pressure', 'temperature', 'pain', 'dose'],
  },
  meeting: {
    name: '회의', icon: '💼',
    rules: [
      'Setting: a business or organisational meeting.',
      'Keep job titles, company and product names accurate; use a formal, concise register.',
    ],
    keywords: [],
  },
  daily: {
    name: '일상 대화', icon: '💬',
    rules: ['Setting: everyday conversation. Natural, friendly but polite language.'],
    keywords: [],
  },
  travel: {
    name: '여행·쇼핑', icon: '🧳',
    rules: [
      'Setting: travel, shopping, transport, restaurants.',
      'Keep prices, numbers, times, addresses and directions exact. Short, simple sentences.',
    ],
    keywords: [],
  },
  custom: {
    name: '직접 설명', icon: '✏️',
    rules: [],
    keywords: [],
  },
};

export function translateInstructions(src, tgt, situationKey, note, glossary = '') {
  const s = SITUATIONS[situationKey] || SITUATIONS.daily;
  const lines = [
    `You are a professional interpreter. Translate the given ${lang(src).en} text into ${lang(tgt).en}. Output ONLY the translation, no notes or quotes.`,
    'Rules:',
    `- Use a polite register (${lang(tgt).polite || 'polite forms'}).`,
    ...s.rules.map((r) => '- ' + r),
    `- Transliterate personal names into the ${lang(tgt).en} writing system.`,
    '- The text comes from speech recognition and may contain mis-heard words. If a word is clearly a recognition error, translate the most plausible intended meaning, silently.',
    '- Never answer questions or add commentary; just translate.',
  ];
  if (note && note.trim()) lines.push(`- Additional context from the user: ${note.trim().slice(0, 300)}`);
  if (glossary && glossary.trim()) lines.push(`- Always use these fixed term translations (glossary, "${lang(src).en} = ${lang(tgt).en}" or the reverse):\n${glossary.trim().slice(0, 3000)}`);
  return lines.join('\n');
}

// 음성 인식 힌트: 사용자 용어 + 상황 용어(선택한 두 언어의 글자로 된 것만)
export function keywords(situationKey, customTerms, pair, matches) {
  const out = [];
  const add = (w) => {
    w = (w || '').replace(/[<>\r\n]/g, ' ').trim().slice(0, 60);
    if (w && !out.includes(w)) out.push(w);
  };
  (customTerms || '').split(/[\n,]/).forEach(add);
  for (const w of (SITUATIONS[situationKey] || {}).keywords || []) {
    if (pair.some((c) => matches(w, c))) add(w);
  }
  return out.slice(0, 100);
}
