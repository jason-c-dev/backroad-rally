// ?audiorec: measurement taps for tools/check/audio.mjs. An AudioWorklet on every mix group and on
// the master measures K-weighted mean square (ITU-R BS.1770) per 100 ms block; the master tap also
// keeps the stereo PCM so the run can be saved as a WAV. Taps only listen (their outputs go to a
// silent sink), so the mix is the same with or without them. Off unless the URL asks for it.
import { GROUPS } from './mix';
import type { AudioSystem } from './system';

const WORKLET = `
class BrTap extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = o.processorOptions;
    this.block = p.block; this.k = p.k;
    // per channel: shelf x1 x2 y1 y2, high-pass y1 y2 (its input is the shelf's output)
    this.s = [new Float64Array(6), new Float64Array(6)];
    this.n = 0; this.ms = 0; this.peak = 0;
    this.out = p.pcm ? new Float32Array(this.block * 2) : null;
  }
  process(inputs) {
    const inp = inputs[0] || [];
    const [b0, b1, b2, a1, a2, h1, h2] = this.k;
    for (let c = 0; c < 2; c++) {
      const ch = inp[c] || inp[0];
      const s = this.s[c];
      for (let i = 0; i < 128; i++) {
        const x = ch ? ch[i] : 0;
        const y = b0 * x + b1 * s[0] + b2 * s[1] - a1 * s[2] - a2 * s[3];
        const z = y - 2 * s[2] + s[3] - h1 * s[4] - h2 * s[5];
        s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y; s[5] = s[4]; s[4] = z;
        this.ms += z * z;
        const a = x < 0 ? -x : x;
        if (a > this.peak) this.peak = a;
        if (this.out) this.out[(this.n + i) * 2 + c] = x;
      }
    }
    this.n += 128;
    if (this.n >= this.block) {
      const msg = { ms: this.ms / this.n, peak: this.peak };
      if (this.out) msg.pcm = this.out.slice(0, this.n * 2);
      this.port.postMessage(msg);
      this.n = 0; this.ms = 0; this.peak = 0;
    }
    return true;
  }
}
registerProcessor('br-tap', BrTap);
`;

/** BS.1770 K-weighting coefficients for a sample rate: [b0, b1, b2, a1, a2] of the shelf, [a1, a2] of the high-pass. */
export function kWeights(fs: number): number[] {
  let K = Math.tan((Math.PI * 1681.974450955533) / fs);
  const Q = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  const shelf = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  K = Math.tan((Math.PI * 38.13547087602444) / fs);
  const Q2 = 0.5003270373238773;
  const d = 1 + K / Q2 + K * K;
  return [...shelf, (2 * (K * K - 1)) / d, (1 - K / Q2 + K * K) / d];
}

export interface RecState {
  [k: string]: number | string | boolean;
}

export interface Recording {
  rate: number;
  block: number;
  groups: Record<string, number[]>;
  peaks: Record<string, number[]>;
  /** Master PCM (stereo, interleaved), and every group but the music (for the click check). */
  pcm: Float32Array[];
  pcmFx: Float32Array[];
  state: RecState[];
  started: boolean;
}

export async function startRecorder(sys: AudioSystem, sample: () => RecState): Promise<Recording> {
  const ctx = sys.ctx;
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  const block = 128 * Math.round(ctx.sampleRate / 10 / 128); // whole render quanta (~0.1 s)
  const rec: Recording = { rate: ctx.sampleRate, block, groups: {}, peaks: {}, pcm: [], pcmFx: [], state: [], started: true };
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);
  const k = kWeights(ctx.sampleRate);
  const tap = (name: string, node: AudioNode, pcm: 'pcm' | 'pcmFx' | null) => {
    const w = new AudioWorkletNode(ctx, 'br-tap', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { block, pcm: !!pcm, k },
    });
    rec.groups[name] = [];
    rec.peaks[name] = [];
    w.port.onmessage = (e: MessageEvent<{ ms: number; peak: number; pcm?: Float32Array }>) => {
      rec.groups[name].push(e.data.ms);
      rec.peaks[name].push(e.data.peak);
      if (e.data.pcm && pcm) {
        rec[pcm].push(e.data.pcm);
        if (pcm === 'pcm') rec.state.push(sample());
      }
    };
    node.connect(w).connect(sink);
  };
  for (const g of GROUPS) tap(g, sys.groups[g], null);
  tap('master', sys.out, 'pcm'); // what reaches the speakers (after the safety limiter)
  const fx = ctx.createGain();
  for (const g of GROUPS) if (g !== 'music') sys.groups[g].connect(fx);
  tap('nomusic', fx, 'pcmFx');
  return rec;
}
