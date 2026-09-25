// Synthesised order sounds (no audio files). Browsers need one click before audio can play.
let ctx: AudioContext | null = null;

export function unlockAudio(): boolean {
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
    return true;
  } catch {
    return false;
  }
}

function tone(freq: number, start: number, dur: number, type: OscillatorType, gain: number) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, ctx.currentTime + start);
  g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
  g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
  o.connect(g).connect(ctx.destination);
  o.start(ctx.currentTime + start);
  o.stop(ctx.currentTime + start + dur + 0.05);
}

/** open: rising two-note chime. win: bright triple ding. loss: soft falling tone. */
export function playOrder(kind: "open" | "win" | "loss") {
  if (!ctx || ctx.state !== "running") return;
  if (kind === "open") {
    tone(660, 0, 0.18, "triangle", 0.18);
    tone(990, 0.09, 0.28, "triangle", 0.16);
  } else if (kind === "win") {
    tone(1047, 0, 0.14, "sine", 0.2);
    tone(1319, 0.08, 0.14, "sine", 0.18);
    tone(1568, 0.16, 0.35, "sine", 0.16);
  } else {
    tone(392, 0, 0.22, "sine", 0.16);
    tone(294, 0.14, 0.4, "sine", 0.14);
  }
}
