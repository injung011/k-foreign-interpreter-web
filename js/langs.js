// 선택 가능한 언어. code: ISO 639-1 (OpenAI·Google 공통), bcp: 브라우저 음성 인식/읽기용 지역 코드
export const LANGS = {
  ko: { name: '한국어', native: '한국어', en: 'Korean', script: 'hangul', bcp: 'ko-KR', polite: 'Korean: 존댓말 (합니다/해요체)' },
  ru: { name: '러시아어', native: 'Русский', en: 'Russian', script: 'cyrillic', bcp: 'ru-RU', polite: 'Russian: always "вы", never "ты"' },
  en: { name: '영어', native: 'English', en: 'English', script: 'latin', bcp: 'en-US', polite: 'English: polite, respectful tone' },
  uk: { name: '우크라이나어', native: 'Українська', en: 'Ukrainian', script: 'cyrillic', bcp: 'uk-UA', polite: 'Ukrainian: always "ви"' },
  kk: { name: '카자흐어', native: 'Қазақша', en: 'Kazakh', script: 'cyrillic', bcp: 'kk-KZ', polite: 'Kazakh: polite "сіз"' },
  uz: { name: '우즈베크어', native: 'Oʻzbekcha', en: 'Uzbek', script: 'latin', bcp: 'uz-UZ', polite: 'Uzbek: polite "siz"' },
  mn: { name: '몽골어', native: 'Монгол', en: 'Mongolian', script: 'cyrillic', bcp: 'mn-MN', polite: 'Mongolian: polite "та"' },
  zh: { name: '중국어', native: '中文', en: 'Chinese (Simplified)', script: 'han', bcp: 'zh-CN', polite: 'Chinese: polite "您"', google: 'zh-CN' },
  ja: { name: '일본어', native: '日本語', en: 'Japanese', script: 'kana', bcp: 'ja-JP', polite: 'Japanese: です/ます form' },
  vi: { name: '베트남어', native: 'Tiếng Việt', en: 'Vietnamese', script: 'latin', bcp: 'vi-VN', polite: 'Vietnamese: respectful forms' },
  th: { name: '태국어', native: 'ไทย', en: 'Thai', script: 'thai', bcp: 'th-TH', polite: 'Thai: polite particles (ครับ/ค่ะ)' },
  id: { name: '인도네시아어', native: 'Bahasa Indonesia', en: 'Indonesian', script: 'latin', bcp: 'id-ID', polite: 'Indonesian: polite "Bapak/Ibu/Anda"' },
  es: { name: '스페인어', native: 'Español', en: 'Spanish', script: 'latin', bcp: 'es-ES', polite: 'Spanish: "usted"/"ustedes"' },
  fr: { name: '프랑스어', native: 'Français', en: 'French', script: 'latin', bcp: 'fr-FR', polite: 'French: "vous"' },
  de: { name: '독일어', native: 'Deutsch', en: 'German', script: 'latin', bcp: 'de-DE', polite: 'German: "Sie"' },
};

export const lang = (c) => LANGS[c] || { name: c, native: c, en: c, script: 'latin', bcp: c, polite: '' };
export const label = (c) => (lang(c).name === lang(c).native ? lang(c).name : `${lang(c).name} · ${lang(c).native}`);
export const googleCode = (c) => lang(c).google || c;
export const sameScript = (a, b) => {
  const s = new Set([lang(a).script, lang(b).script]);
  return s.size === 1 || (s.has('han') && s.has('kana'));
};
