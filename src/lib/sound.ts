import { load } from "./storage";

let ctx: AudioContext | undefined;

function tone(freq: number, ms: number, type: OscillatorType = "sine", gain = 0.12, delay = 0) {
  if (!load("settings", { sound: true } as { sound?: boolean }).sound) return;
  try {
    ctx ??= new AudioContext();
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + ms / 1000);
  } catch {
    /* no audio */
  }
}

export const Sound = {
  move: (capture = false) => (capture ? (tone(220, 90, "triangle", 0.2), tone(140, 120, "sine", 0.15, 0.02)) : tone(420, 60, "triangle", 0.16)),
  forSan: (san: string) => Sound.move(san.includes("x")),
  error: () => tone(130, 220, "sawtooth", 0.07),
  success: () => (tone(660, 120), tone(990, 220, "sine", 0.12, 0.1)),
  end: () => (tone(523, 160), tone(659, 160, "sine", 0.12, 0.14), tone(784, 320, "sine", 0.12, 0.28)),
};
