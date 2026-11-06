// node --test tests/   (브라우저 없이 핵심 로직 시험)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { label, sameScript } from '../js/langs.js';
import { OpenAIClient } from '../js/openai.js';
import { keywords, translateInstructions } from '../js/situations.js';
import { Reblocker, Resampler, Segmenter } from '../js/segmenter.js';
import { clean, isHallucination, langFromText, looksTranslated, matchesLang } from '../js/textfilter.js';
import { toWav, wavDuration } from '../js/wav.js';

const SR = 16000;
const tone = (sec, amp, f = 220) => Float32Array.from({ length: sec * SR }, (_, i) => {
  const t = i / SR;
  return amp * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * f * t);
});
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const noise = (sec, amp) => Float32Array.from({ length: sec * SR }, () => rnd() * 2 * amp * 1.7);
const cat = (...a) => { const o = new Float32Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const run = (sig, seg) => { const out = []; for (let i = 0; i + 1600 <= sig.length; i += 1600) out.push(...seg.feed(sig.subarray(i, i + 1600)).utterances); return out; };

test('segmenter: two sentences', () => {
  const sig = cat(noise(1, 0.002), tone(2, 0.08), noise(1.2, 0.002), tone(1.5, 0.08), noise(1.5, 0.002));
  const u = run(sig, new Segmenter(5, 0.8, 12));
  assert.equal(u.length, 2);
  assert.ok(u[0].length / SR >= 2 && u[0].length / SR <= 3);
});

test('segmenter: speaking right away, long speech split ≤ 12 s', () => {
  const parts = [];
  for (let i = 0; i < 10; i++) parts.push(tone(2.8, 0.08, 200 + i * 10), noise(0.2, 0.004));
  const u = run(cat(...parts, noise(1.5, 0.002)), new Segmenter(5, 0.8, 12));
  assert.ok(u.length >= 3);
  assert.ok(u.every((x) => x.length / SR <= 12.05));
});

test('segmenter: clicks and noise ignored; quiet speaker with high sensitivity', () => {
  const n = noise(5, 0.003); n[16000] += 0.5;
  assert.equal(run(n, new Segmenter(5, 0.8, 12)).length, 0);
  assert.equal(run(cat(noise(1, 0.001), tone(2, 0.012), noise(1.5, 0.001)), new Segmenter(9, 0.8, 12)).length, 1);
});

test('resampler 48k → 16k keeps frequency and length', () => {
  const src = 48000;
  const x = Float32Array.from({ length: src * 2 }, (_, i) => Math.sin(2 * Math.PI * 1000 * i / src));
  const r = new Resampler(src);
  const rb = new Reblocker();
  let n = 0, out = [];
  for (let i = 0; i < x.length; i += 4800) for (const b of rb.push(r.process(x.subarray(i, i + 4800)))) { n += b.length; out.push(b); }
  assert.ok(Math.abs(n - 2 * SR) <= 1600);
  // 영점 교차 수로 주파수 확인 (1kHz → 1초에 약 2000번)
  const y = cat(...out).subarray(2000, 18000);
  let z = 0; for (let i = 1; i < y.length; i++) if ((y[i - 1] < 0) !== (y[i] < 0)) z++;
  assert.ok(Math.abs(z - 2000) < 40, `zero crossings ${z}`);
});

test('text filters', () => {
  assert.ok(matchesLang('하나님께 감사', 'ko') && matchesLang('Слава Богу', 'ru') && matchesLang('皆さん、ようこそ', 'ja'));
  assert.equal(langFromText('Hola', ['en', 'es']), null);
  assert.equal(langFromText('안녕하세요', ['ko', 'ru']), 'ko');
  assert.ok(isHallucination('시청해주셔서 감사합니다.') && isHallucination('Продолжение следует...'));
  assert.ok(!isHallucination('감사합니다'));
  assert.equal(clean('아멘 아멘 아멘 아멘 아멘'), '아멘');
  assert.ok(!looksTranslated('У вас продаются такие?', 'У вас продаются такие?', 'ko'));
  assert.ok(looksTranslated('김인중 형제입니다', 'Брат Ким Ин Джун.', 'ru'));
  assert.ok(sameScript('en', 'es') && !sameScript('ko', 'ru'));
  assert.equal(label('ru'), '러시아어 · Русский');
});

test('wav encoding', () => {
  const w = toWav(tone(1.5, 0.1));
  assert.equal(String.fromCharCode(...w.slice(0, 4)), 'RIFF');
  assert.ok(Math.abs(wavDuration(w) - 1.5) < 0.001);
});

test('situation instructions and keywords', () => {
  const t = translateInstructions('ko', 'ru', 'hospital', '소아과 진료');
  assert.match(t, /NEVER change numbers, doses/);
  assert.match(t, /"вы"/);
  assert.match(t, /소아과 진료/);
  const c = translateInstructions('ko', 'ru', 'church', '');
  assert.match(c, /брат OOO/);
  const kw = keywords('church', '김인중\n사랑의교회', ['en', 'es'], matchesLang);
  assert.ok(kw.includes('김인중') && kw.includes('Pastor') && !kw.includes('목사님'));
});

// ---- OpenAI 클라이언트 (가짜 fetch)
function fakeFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const r = await handler(url, opts, calls.length);
    return new Response(r.body instanceof Uint8Array ? r.body : JSON.stringify(r.body), { status: r.status || 200 });
  };
  return calls;
}

test('openai: transcribe sends languages and keywords; model fallback', async () => {
  const calls = fakeFetch(async (url, opts) => {
    const fd = opts.body;
    if (fd.get('model') === 'gpt-transcribe') return { status: 404, body: { error: { code: 'model_not_found', message: 'The model does not exist' } } };
    return { body: { text: 'Слава Богу' } };
  });
  const c = new OpenAIClient('sk-x', 'http://mock/v1');
  const r = await c.transcribe(tone(2, 0.1), { mode: 'ru', pair: ['ko', 'ru'], keywords: ['брат'], prompt: 'p' });
  assert.equal(r.text, 'Слава Богу');
  assert.equal(c.asrModel, 'gpt-4o-transcribe');
  assert.deepEqual(calls[0].opts.body.getAll('languages[]'), ['ru']);
  assert.deepEqual(calls[0].opts.body.getAll('keywords[]'), ['брат']);
  assert.equal(calls[1].opts.body.get('language'), 'ru');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer sk-x');
});

test('openai: translate retries when the model echoes the original', async () => {
  let n = 0;
  fakeFetch(async () => {
    n++;
    const text = n === 1 ? 'Ручку.' : '펜 주세요.';
    return { body: { output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 100, output_tokens: 10 } } };
  });
  const c = new OpenAIClient('sk-x', 'http://mock/v1');
  const r = await c.translate('Ручку.', 'ru', 'ko', { situation: 'travel' });
  assert.equal(r.text, '펜 주세요.');
  assert.equal(n, 2);
  assert.ok(r.cost > 0);
});

test('openai: error kinds', async () => {
  fakeFetch(async () => ({ status: 401, body: { error: { code: 'invalid_api_key', message: 'Incorrect API key' } } }));
  await assert.rejects(new OpenAIClient('bad', 'http://mock/v1').check(), (e) => e.kind === 'auth' && /키/.test(e.userMessage));
  fakeFetch(async () => ({ status: 429, body: { error: { code: 'insufficient_quota', message: 'quota' } } }));
  await assert.rejects(new OpenAIClient('k', 'http://mock/v1').check(), (e) => e.kind === 'quota');
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(new OpenAIClient('k', 'http://mock/v1').check(), (e) => e.kind === 'network');
});

test('설정 이전: 옛 기본값 0.8초 → 1.0초, 직접 바꾼 값은 유지', async () => {
  const mem = {};
  globalThis.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const store = await import('../js/store.js');
  mem['kfi.settings'] = JSON.stringify({ silenceSec: 0.8 });
  assert.equal(store.loadSettings().silenceSec, 1.0);
  mem['kfi.settings'] = JSON.stringify({ silenceSec: 1.4 });
  assert.equal(store.loadSettings().silenceSec, 1.4);
  mem['kfi.settings'] = JSON.stringify({ silenceSec: 0.8, asrV: 2 });
  assert.equal(store.loadSettings().silenceSec, 0.8);
  assert.equal(store.loadSettings().noiseSuppression, false);
});

test('대본: 형식 읽기(여러 줄, 계속 표시, 용어표)', async () => {
  const { parseScript, glossaryKeywords } = await import('../js/script.js');
  const sc = parseScript(`[1]\nKO: 1. 첫 제목\nRU: 1. Первый заголовок\n\n[2]\nKO: 하나님은 사랑이십니다.\n이어지는 줄입니다.\nRU: Бог есть любовь.\n— 계속 —\n[3]\nKO: 감사합니다.\nRU: Благодарю вас.\n\n용어표\n하나님 = Бог\n예수님 / 예수 그리스도 = Иисус / Иисус Христос\n`);
  assert.equal(sc.segs.length, 3);
  assert.deepEqual(sc.langs, ['ko', 'ru']);
  assert.equal(sc.segs[1].t.ko, '하나님은 사랑이십니다. 이어지는 줄입니다.');
  assert.equal(sc.terms.length, 2);
  assert.deepEqual(glossaryKeywords(sc.terms, 'a'), ['하나님', '예수님', '예수 그리스도']);
  assert.throws(() => parseScript('그냥 글'), /format/);
});

test('대본: 위치 따라가기 — 말 바꿈·오타는 따라가고, 대본에 없는 말은 구분', async () => {
  const { parseScript, ScriptTracker } = await import('../js/script.js');
  const lines = ['오늘 본문은 요한복음 삼장 십육절입니다', '하나님이 세상을 이처럼 사랑하사 독생자를 주셨으니', '이는 그를 믿는 자마다 멸망하지 않고 영생을 얻게 하려 하심이라',
    '우리는 이 사랑을 받은 사람들입니다', '그렇다면 우리는 어떻게 살아야 할까요', '이웃을 내 몸과 같이 사랑해야 합니다', '말로만 하지 말고 행함과 진실함으로 사랑합시다',
    '이것이 오늘 말씀의 결론입니다', '함께 기도하겠습니다'];
  const sc = parseScript(lines.map((k, i) => `[${i + 1}]\nKO: ${k}\nRU: ru ${i}`).join('\n\n'));
  const tr = new ScriptTracker(sc.segs, 'ko');
  const step = (text) => { const m = tr.match(text); if (m) tr.cur = m.idx; return m && m.idx; };
  assert.equal(step('오늘 본문은 요한복음 3장 16절입니다'), 0);
  assert.equal(step('하나님이 세상을 이처럼 사랑하셔서 독생자를'), 1);          // 말 바꿈
  assert.equal(step('그를 믿는 자마다 멸망치 않고 영생을 얻게'), 2);
  assert.equal(step('여러분 점심은 식당에서 드시면 됩니다'), null);             // 대본에 없는 말
  assert.equal(step('이웃을 내 몸 같이 사랑해야 합니다'), 5);                    // 두 구간 건너뜀
  assert.equal(step('행함과 진실함으로 사람합시다'), 6);                          // 인식 오타
  assert.equal(step('우리는 이 사랑을 받은 사람들입니다'), 3);                   // 앞으로 돌아감
  assert.ok(tr.upcoming(30).startsWith('우리는 이 사랑을'));
});
