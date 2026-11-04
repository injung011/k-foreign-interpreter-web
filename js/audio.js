// 마이크 → 16kHz 0.1초 블록
import { Reblocker, Resampler, SR } from './segmenter.js';

export class MicCapture {
  constructor(onBlock) {
    this.onBlock = onBlock;
    this.ctx = null;
    this.stream = null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      // 브라우저 에코 제거: 스피커로 읽어 주는 소리가 다시 인식되는 것을 줄임
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    let ctx;
    try { ctx = new AudioContext({ sampleRate: SR }); } catch (e) { ctx = new AudioContext(); }
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    const src = ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(ctx, 'capture');
    const resampler = new Resampler(ctx.sampleRate);
    const reblock = new Reblocker();
    node.port.onmessage = (e) => {
      for (const b of reblock.push(resampler.process(e.data))) this.onBlock(b);
    };
    src.connect(node);
    // 일부 브라우저는 출력에 연결해야 처리가 돌아감(무음으로 연결)
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
    this.node = node;
    if (ctx.state === 'suspended') await ctx.resume();
    const track = this.stream.getAudioTracks()[0];
    return track ? track.label : '';
  }

  stop() {
    try { this.node && this.node.port.close(); } catch (e) { /* 무시 */ }
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
    this.stream = this.ctx = this.node = null;
  }
}
