// Float32 음성 → 16비트 WAV (OpenAI로 보낼 형식)
export function toWav(samples, rate = 16000) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export function wavDuration(bytes) {
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rate = v.getUint32(24, true), bps = v.getUint16(34, true) / 8, ch = v.getUint16(22, true);
    // data 청크 찾기
    let o = 12;
    while (o + 8 <= bytes.length) {
      const id = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
      const size = v.getUint32(o + 4, true);
      if (id === 'data') return Math.min(size, bytes.length - o - 8) / (rate * bps * ch);
      o += 8 + size;
    }
  } catch (e) { /* 무시 */ }
  return 0;
}
