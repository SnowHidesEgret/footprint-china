/**
 * 点亮中国 · Web Audio 音效引擎（零依赖）
 * 集中管理合成音色、连击音调、成就琶音与省电逻辑
 */

export const AUDIO_PARAMS = {
  LIGHT: { baseFreq: 800, type: 'sine', lowpass: 2400, peakDb: -16, attackMs: 5, decayMs: 180 },
  UNLIGHT: { freq: 400, type: 'sine', lowpass: 1200, peakDb: -18, decayMs: 150 },
  ACHIEVE: { notes: [523.25, 659.25, 783.99], noteMs: 120, overlapMs: 20, type: 'sine', lowpass: 3000, peakDb: -16 },
};

let ctx = null;
let enabled = true;

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/**
 * 延迟初始化 AudioContext
 * 若 soundEnabled 为 false 则直接返回 null，不创建上下文
 */
export function ensureCtx() {
  if (!enabled) return null;
  if (typeof window === 'undefined') return null;

  try {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
    }
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  } catch (err) {
    console.warn('AudioContext 初始化失败:', err);
    return null;
  }
}

/**
 * 设置音效开启/静音状态
 * 静音时 suspend 已有 ctx 以节省系统资源与功耗
 */
export function setEnabled(bool) {
  enabled = Boolean(bool);
  if (!enabled && ctx && ctx.state === 'running') {
    ctx.suspend().catch(() => {});
  }
}

export function isEnabled() {
  return enabled;
}

/**
 * 播放点亮音效
 * @param {number} combo 连击半音数偏移（0 为 800Hz 基频）
 */
export function playLight(combo = 0) {
  if (!enabled) return;
  const c = ensureCtx();
  if (!c) return;

  try {
    if (c.state === 'suspended') {
      c.resume().catch(() => {});
    }
    const p = AUDIO_PARAMS.LIGHT;
    const semitones = Number(combo) || 0;
    const freq = p.baseFreq * Math.pow(2, semitones / 12);
    const peakGain = dbToGain(p.peakDb);
    const now = c.currentTime;

    const osc = c.createOscillator();
    osc.type = p.type;
    osc.frequency.setValueAtTime(freq, now);

    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(p.lowpass, now);

    const gain = c.createGain();
    const attackSec = Math.max(p.attackMs / 1000, 0.002);
    const decaySec = Math.max(p.decayMs / 1000, 0.01);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peakGain, now + attackSec);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + attackSec + decaySec);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(c.destination);

    const stopTime = now + attackSec + decaySec + 0.05;
    osc.start(now);
    osc.stop(stopTime);
    osc.onended = () => {
      try {
        osc.disconnect();
        filter.disconnect();
        gain.disconnect();
      } catch {}
    };
  } catch (err) {
    console.warn('播放点亮音效失败:', err);
  }
}

/**
 * 播放熄灭音效
 */
export function playUnlight() {
  if (!enabled) return;
  const c = ensureCtx();
  if (!c) return;

  try {
    if (c.state === 'suspended') {
      c.resume().catch(() => {});
    }
    const p = AUDIO_PARAMS.UNLIGHT;
    const peakGain = dbToGain(p.peakDb);
    const now = c.currentTime;

    const osc = c.createOscillator();
    osc.type = p.type;
    osc.frequency.setValueAtTime(p.freq, now);

    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(p.lowpass, now);

    const gain = c.createGain();
    const attackSec = 0.005;
    const decaySec = Math.max(p.decayMs / 1000, 0.01);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peakGain, now + attackSec);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + attackSec + decaySec);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(c.destination);

    const stopTime = now + attackSec + decaySec + 0.05;
    osc.start(now);
    osc.stop(stopTime);
    osc.onended = () => {
      try {
        osc.disconnect();
        filter.disconnect();
        gain.disconnect();
      } catch {}
    };
  } catch (err) {
    console.warn('播放熄灭音效失败:', err);
  }
}

/**
 * 播放里程碑达成音效（琶音上行三音）
 */
export function playAchievement() {
  if (!enabled) return;
  const c = ensureCtx();
  if (!c) return;

  try {
    if (c.state === 'suspended') {
      c.resume().catch(() => {});
    }
    const p = AUDIO_PARAMS.ACHIEVE;
    const peakGain = dbToGain(p.peakDb);
    const now = c.currentTime;
    const noteSec = Math.max(p.noteMs / 1000, 0.02);
    const stepSec = Math.max((p.noteMs - p.overlapMs) / 1000, 0.01);

    p.notes.forEach((freq, idx) => {
      const t0 = now + idx * stepSec;
      const osc = c.createOscillator();
      osc.type = p.type;
      osc.frequency.setValueAtTime(freq, t0);

      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(p.lowpass, t0);

      const gain = c.createGain();
      gain.gain.value = 0.0001;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peakGain, t0 + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + noteSec);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(c.destination);

      const stopTime = t0 + noteSec + 0.05;
      osc.start(t0);
      osc.stop(stopTime);
      osc.onended = () => {
        try {
          osc.disconnect();
          filter.disconnect();
          gain.disconnect();
        } catch {}
      };
    });
  } catch (err) {
    console.warn('播放成就音效失败:', err);
  }
}
