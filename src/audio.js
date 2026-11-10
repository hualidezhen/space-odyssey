// 程序化音效：无任何外部音频文件，全部用 WebAudio 合成
// - 深空低频铺底（三音簇 pad）
// - 引擎声：随速度变化的锯齿 + 噪声
// - 跃迁：上升扫频 + 噪声爆冲
// - UI：短促的金属点击
// 所有连接都包在 try/catch 里，音频不可用时静默降级，不影响渲染。

export function createAudio() {
  let ctx = null;
  let master = null;
  let padGain = null;
  let engGain = null;
  let engFilter = null;
  let engOscs = [];
  let engNoise = null;
  let muted = false;
  let ready = false;

  function makeNoiseBuffer(c) {
    const len = c.sampleRate * 2;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.2;
    }
    return buf;
  }

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);

    // ── 深空铺底 ──
    padGain = ctx.createGain();
    padGain.gain.value = 0.0;
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 520;
    padFilter.Q.value = 0.6;
    padGain.connect(padFilter).connect(master);
    for (const [freq, type, det] of [[55, 'sine', 0], [82.5, 'triangle', 4], [110, 'sine', -6], [164.8, 'sine', 8]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = freq > 150 ? 0.16 : 0.34;
      o.connect(g).connect(padGain);
      o.start();
    }
    // 极慢的呼吸感
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.22;
    lfo.connect(lfoGain).connect(padGain.gain);
    lfo.start();
    padGain.gain.value = 0.5;

    // ── 引擎 ──
    engFilter = ctx.createBiquadFilter();
    engFilter.type = 'lowpass';
    engFilter.frequency.value = 260;
    engFilter.Q.value = 3.2;
    engGain = ctx.createGain();
    engGain.gain.value = 0.0;
    engFilter.connect(engGain).connect(master);
    for (const [freq, type, det] of [[38, 'sawtooth', 0], [57, 'sawtooth', -7], [76, 'square', 5]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = det;
      o.connect(engFilter);
      o.start();
      engOscs.push(o);
    }
    engNoise = ctx.createBufferSource();
    engNoise.buffer = makeNoiseBuffer(ctx);
    engNoise.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 420;
    nf.Q.value = 0.9;
    const ng = ctx.createGain();
    ng.gain.value = 0.35;
    engNoise.connect(nf).connect(ng).connect(engGain);
    engNoise.start();

    ready = true;
  }

  function unlock() {
    try {
      init();
      if (ctx && ctx.state === 'suspended') ctx.resume();
    } catch (e) { /* 静默降级 */ }
  }

  function setEngine(v) {
    if (!ready || muted) return;
    const k = Math.max(0, Math.min(1, v));
    try {
      const t = ctx.currentTime;
      engGain.gain.setTargetAtTime(0.02 + k * 0.16, t, 0.18);
      engFilter.frequency.setTargetAtTime(220 + k * 900, t, 0.2);
      engOscs.forEach((o, i) => o.frequency.setTargetAtTime((38 + i * 19) * (1 + k * 0.55), t, 0.25));
    } catch (e) {}
  }

  function warp() {
    if (!ready || muted) return;
    try {
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(1400, t + 0.85);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(400, t);
      f.frequency.exponentialRampToValueAtTime(4000, t + 0.8);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      o.connect(f).connect(g).connect(master);
      o.start(t); o.stop(t + 1.2);

      const n = ctx.createBufferSource();
      n.buffer = makeNoiseBuffer(ctx);
      const nf = ctx.createBiquadFilter();
      nf.type = 'highpass';
      nf.frequency.setValueAtTime(300, t);
      nf.frequency.exponentialRampToValueAtTime(6000, t + 0.9);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.exponentialRampToValueAtTime(0.3, t + 0.2);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
      n.connect(nf).connect(ng).connect(master);
      n.start(t); n.stop(t + 1.4);
    } catch (e) {}
  }

  function blip(freq = 880) {
    if (!ready || muted) return;
    try {
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(freq * 0.62, t + 0.09);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.075, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(master);
      o.start(t); o.stop(t + 0.18);
    } catch (e) {}
  }

  function toggle() {
    muted = !muted;
    try {
      if (master) master.gain.setTargetAtTime(muted ? 0 : 0.55, ctx.currentTime, 0.1);
    } catch (e) {}
    return muted;
  }

  return {
    unlock, setEngine, warp, blip, toggle,
    get muted() { return muted; },
    get ready() { return ready; },
  };
}
