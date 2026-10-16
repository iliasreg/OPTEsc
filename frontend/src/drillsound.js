// Drill sounds, made in the browser with Web Audio (no sound files). Fire: the evacuation alarm
// from the moment people are warned, in the "temporal-three" pattern of fire alarms (ISO 8201:
// three 0.5 s tones, then 1.5 s of silence), or a chime and a spoken message for a voice alarm.
// Earthquake: a rumble as strong as the shaking, and a crash as each wall or cupboard lands.
// Sounds follow the simulation clock and stop when playback pauses or ends.
import { shakeAt } from './quake.js';

const VOICE_MESSAGE = 'Attention please. An emergency has been reported in the building. Please leave now by the nearest exit. Do not use the lifts.';
const IMPACT_S = { wall: 1.0, topple: 0.8 }; // as in sim.js: when a falling element reaches the floor

export class DrillSound {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.result = null;
  }

  // Browsers start audio only from a click: call this in the click handler.
  unlock() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.silence();
  }

  load(result) {
    this.silence();
    this.result = result;
    this.lastT = null;
    const fm = result.fireModel;
    this.alarmFrom = fm && Number.isFinite(fm.warned) ? fm.warned : null;
    this.voice = result.params?.alarm === 'voice';
    this.quake = result.quake || null;
    this.impacts = this.quake ? this.quake.events.filter((e) => e.type !== 'door').map((e) => e.t + (IMPACT_S[e.type] ?? 1)).sort((a, b) => a - b) : [];
  }

  // What the playback shows at time t; null when nothing is sounding.
  state(t) {
    if (this.alarmFrom != null && t >= this.alarmFrom) return 'alarm';
    if (this.quake && shakeAt(this.quake, t) > 0.05) return 'shaking';
    return null;
  }

  update(t, playing) {
    const forward = this.lastT != null && t >= this.lastT && t - this.lastT < 3;
    const from = this.lastT;
    this.lastT = t;
    if (!this.ctx || !this.enabled || !playing || !this.result) { this.silence(); return; }
    // fire alarm
    const ringing = this.alarmFrom != null && t >= this.alarmFrom;
    if (ringing && !this.alarm) this.startAlarm();
    else if (!ringing && this.alarm) this.stopAlarm();
    if (ringing && this.voice) this.speakEvery(14000);
    // earthquake rumble, and a crash for whatever lands since the last update
    if (this.quake) {
      this.rumbleGain ||= this.startRumble();
      this.rumbleGain.gain.setTargetAtTime(0.9 * shakeAt(this.quake, t), this.ctx.currentTime, 0.1);
      if (forward) {
        let n = 0;
        for (const at of this.impacts) if (at > from && at <= t && n++ < 3) this.crash(n);
      }
    }
  }

  silence() {
    this.stopAlarm();
    if (this.rumbleGain) { this.rumbleGain.disconnect(); this.rumbleSrc.stop(); this.rumbleGain = null; }
    if (this.spoke && globalThis.speechSynthesis) speechSynthesis.cancel();
    this.spoke = null;
  }

  // ---------- sounds ----------
  buffer(seconds, fill) {
    const sr = this.ctx.sampleRate, b = this.ctx.createBuffer(1, Math.round(seconds * sr), sr), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = fill(i / sr, i);
    return b;
  }

  startAlarm() {
    // a voice alarm: a chime and the message, repeated (speakEvery)
    if (this.voice) { this.alarm = { stop() {} }; return; }
    // temporal-three: on 0.5 s, off 0.5 s, three times, then off 1.5 s; a 950 Hz tone with an overtone
    this.alarmBuf ||= this.buffer(4, (t) => {
      const k = Math.floor(t);
      const on = k < 3 && t - k < 0.5;
      if (!on) return 0;
      const u = t - k, edge = Math.min(1, u / 0.01, (0.5 - u) / 0.01);
      const s = Math.sin(2 * Math.PI * 950 * t);
      return edge * (0.55 * s + 0.12 * Math.sign(s));
    });
    const src = this.ctx.createBufferSource();
    src.buffer = this.alarmBuf; src.loop = true;
    src.connect(this.master); src.start();
    this.alarm = src;
  }

  stopAlarm() {
    if (!this.alarm) return;
    try { this.alarm.stop(); } catch { /* already stopped */ }
    this.alarm = null;
  }

  speakEvery(ms) {
    const now = performance.now();
    if (this.spoke && now - this.spoke < ms) return;
    this.spoke = now;
    // chime: two falling notes
    for (const [f, at] of [[880, 0], [660, 0.45]]) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain(), t0 = this.ctx.currentTime + at;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.7, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);
      o.connect(g).connect(this.master); o.start(t0); o.stop(t0 + 1);
    }
    if (globalThis.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(VOICE_MESSAGE);
      u.lang = 'en-GB'; u.rate = 0.95;
      setTimeout(() => { if (this.spoke === now) speechSynthesis.speak(u); }, 1100);
    }
  }

  startRumble() {
    // brown noise, low-passed: the deep roar of the ground and the building
    let last = 0;
    this.rumbleBuf ||= this.buffer(3, () => { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; return 3.5 * last; });
    const src = this.ctx.createBufferSource();
    src.buffer = this.rumbleBuf; src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 160;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(lp).connect(g).connect(this.master);
    src.start();
    this.rumbleSrc = src;
    return g;
  }

  crash(n) {
    // a thud and a burst of falling debris
    const t0 = this.ctx.currentTime + 0.05 * n;
    this.crashBuf ||= this.buffer(1.2, (t) => (Math.random() * 2 - 1) * Math.exp(-t * 4.5));
    const src = this.ctx.createBufferSource();
    src.buffer = this.crashBuf;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900;
    const g = this.ctx.createGain();
    g.gain.value = 0.9;
    src.connect(lp).connect(g).connect(this.master);
    src.start(t0);
    const o = this.ctx.createOscillator(), og = this.ctx.createGain();
    o.frequency.setValueAtTime(90, t0); o.frequency.exponentialRampToValueAtTime(35, t0 + 0.4);
    og.gain.setValueAtTime(1, t0); og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
    o.connect(og).connect(this.master); o.start(t0); o.stop(t0 + 0.55);
  }
}
