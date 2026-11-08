// 에너지 기반 발화 구간 분리 (PC 버전 audio.py의 Segmenter와 같은 동작)
// - 주변 소음 수준 = 최근 20초 동안 가장 조용했던 순간들(하위 5%). 쉬지 않고 길게 말해도
//   말소리를 소음으로 착각해 귀가 먹지 않게 함(예전 방식은 12초쯤 뒤부터 빠른 말을 거의 놓쳤음)
// - 말이 시작되면(임계값 위) 목소리가 임계값의 절반 아래로 떨어질 때까지 계속 듣기(작게 이어지는 말도 놓치지 않게)
// - 말이 끝나고 silenceSec 동안 조용하면 한 문장으로 내보냄
// - maxSec을 넘으면 최근 2초 중 가장 조용한 지점에서 자름
export const SR = 16000;
export const BLOCK = 1600; // 0.1초
const NOISE_WINDOW = 200; // 20초

export function rms(block) {
  let s = 0;
  for (let i = 0; i < block.length; i++) s += block[i] * block[i];
  return block.length ? Math.sqrt(s / block.length) : 0;
}

function concat(blocks) {
  const n = blocks.reduce((a, b) => a + b.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}

export class Segmenter {
  constructor(sensitivity = 5, silenceSec = 0.8, maxSec = 12) {
    this.blockSec = BLOCK / SR;
    this.noise = null;
    this.warm = [];
    this.hist = []; // 최근 블록 소리 크기(소음 추정용) — reset()해도 유지
    this.setParams(sensitivity, silenceSec, maxSec);
    this.reset();
  }

  setParams(sensitivity, silenceSec, maxSec) {
    if (sensitivity != null) {
      const s = Math.min(10, Math.max(1, sensitivity));
      this.factor = 1.6 + (10 - s) * 0.3;       // 5 → 소음의 3.1배(예전 3.85배는 먼 마이크의 말을 놓침)
      this.minLevel = 0.0015 + (10 - s) * 0.0006;
    }
    if (silenceSec != null) this.silenceBlocks = Math.max(2, Math.round(silenceSec / this.blockSec));
    if (maxSec != null) this.maxBlocks = Math.max(30, Math.round(maxSec / this.blockSec));
  }

  reset() {
    this.active = false;
    this.frames = [];
    this.levels = [];
    this.pre = [];
    this.loudRun = 0;
    this.quiet = 0;
    this.speech = 0;
  }

  get threshold() {
    return Math.max(this.minLevel, (this.noise ?? this.minLevel) * this.factor);
  }

  _updateNoise(level) {
    this.hist.push(level);
    if (this.hist.length > NOISE_WINDOW) this.hist.shift();
    if (this.hist.length < 10) return;
    const sorted = [...this.hist].sort((a, b) => a - b);
    const low = sorted[Math.floor(sorted.length * 0.02)]; // 쉬지 않고 말해도 숨 쉬는 틈 몇 번이면 충분
    this.noise = Math.max(1e-5, low * 1.2);
  }

  _emit(frames, levels) {
    if (!frames.length) return null;
    const speech = levels.filter((l) => l > this.threshold * 0.5).length; // 작게 이어진 말도 말로 셈
    if (speech < 4 && this.speech < 4) return null;
    return concat(frames);
  }

  // 반환 { utterances: Float32Array[], level, threshold, active }
  feed(block) {
    const level = rms(block);
    const out = [];
    if (this.noise === null) {
      this.pre.push([block, level]);
      this.pre = this.pre.slice(-8);
      this.warm.push(level);
      if (this.warm.length >= 3) { this.noise = Math.max(1e-5, Math.min(Math.min(...this.warm), 0.006)); this.warm = []; }
      return { utterances: out, level, threshold: this.threshold, active: false };
    }
    this._updateNoise(level);
    const thr = this.threshold;
    const loud = level > thr;
    if (!this.active) {
      this.pre.push([block, level]);
      this.pre = this.pre.slice(-8);
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= 2) {
        this.active = true;
        this.frames = this.pre.map((p) => p[0]);
        this.levels = this.pre.map((p) => p[1]);
        this.speech = this.loudRun;
        this.quiet = 0;
        this.pre = [];
      }
      return { utterances: out, level, threshold: thr, active: this.active };
    }
    this.frames.push(block);
    this.levels.push(level);
    if (loud) this.speech++;
    if (level > thr * 0.5) this.quiet = 0; else this.quiet++;

    if (this.quiet >= this.silenceBlocks) {
      const keep = this.frames.length - this.quiet + 3;
      const seg = this._emit(this.frames.slice(0, keep), this.levels.slice(0, keep));
      if (seg) out.push(seg);
      this.reset();
    } else if (this.frames.length >= this.maxBlocks) {
      const win = Math.min(20, this.levels.length - 5);
      const start = this.levels.length - win;
      let cut = start, min = Infinity;
      for (let i = start; i < this.levels.length; i++) if (this.levels[i] < min) { min = this.levels[i]; cut = i; }
      cut += 1;
      const seg = this._emit(this.frames.slice(0, cut), this.levels.slice(0, cut));
      if (seg) out.push(seg);
      this.frames = this.frames.slice(cut);
      this.levels = this.levels.slice(cut);
      this.speech = this.levels.filter((l) => l > this.threshold * 0.5).length;
      this.quiet = 0;
    }
    return { utterances: out, level, threshold: thr, active: this.active };
  }

  flush() {
    const seg = this.active && this.speech >= 4 && this.frames.length ? concat(this.frames) : null;
    this.reset();
    return seg;
  }
}

// 임의 길이 조각을 BLOCK 크기 블록으로
export class Reblocker {
  constructor(size = BLOCK) { this.size = size; this.buf = new Float32Array(0); }
  push(x) {
    const b = new Float32Array(this.buf.length + x.length);
    b.set(this.buf); b.set(x, this.buf.length);
    const out = [];
    let o = 0;
    while (b.length - o >= this.size) { out.push(b.slice(o, o + this.size)); o += this.size; }
    this.buf = b.slice(o);
    return out;
  }
}

// 다른 샘플레이트 → 16kHz (저역 필터 + 선형 보간, 연속 처리)
export class Resampler {
  constructor(src, dst = SR, taps = 63) {
    this.step = src / dst;
    this.pass = Math.abs(src - dst) < 1;
    if (this.pass) return;
    const cutoff = (0.9 * (dst / 2)) / src;
    const h = new Float32Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const n = i - (taps - 1) / 2;
      const sinc = n === 0 ? 1 : Math.sin(Math.PI * 2 * cutoff * n) / (Math.PI * 2 * cutoff * n);
      const ham = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
      h[i] = 2 * cutoff * sinc * ham;
      sum += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= sum;
    this.h = h;
    this.hist = new Float32Array(taps - 1);
    this.buf = new Float32Array(0);
    this.pos = 0;
  }
  process(x) {
    if (this.pass) return x;
    const T = this.h.length;
    const ext = new Float32Array(this.hist.length + x.length);
    ext.set(this.hist); ext.set(x, this.hist.length);
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let s = 0;
      for (let k = 0; k < T; k++) s += ext[i + k] * this.h[T - 1 - k];
      y[i] = s;
    }
    this.hist = ext.slice(ext.length - (T - 1));
    const b = new Float32Array(this.buf.length + y.length);
    b.set(this.buf); b.set(y, this.buf.length);
    const last = b.length - 1;
    if (last < 1) { this.buf = b; return new Float32Array(0); }
    const count = Math.floor((last - this.pos) / this.step) + 1;
    const out = new Float32Array(Math.max(0, count));
    for (let k = 0; k < count; k++) {
      const t = this.pos + k * this.step;
      const i = Math.floor(t), f = t - i;
      out[k] = i + 1 <= last ? b[i] * (1 - f) + b[i + 1] * f : b[i];
    }
    const next = this.pos + count * this.step;
    const drop = Math.min(Math.floor(next), b.length - 1);
    this.buf = b.slice(drop);
    this.pos = next - drop;
    return out;
  }
}
