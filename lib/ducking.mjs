import { writeFile } from "node:fs/promises";

// Adapted from the local Auto Ducking demo: overlapping ramps use minimum gain.
export function duckingWindows(segments, gap = 0) {
  const windows = segments.map(({ start, end }) => ({ start: Math.max(0, start), end }))
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a.start - b.start);
  return windows.reduce((merged, window) => {
    const last = merged.at(-1);
    if (last && window.start <= last.end + gap) last.end = Math.max(last.end, window.end);
    else merged.push({ ...window });
    return merged;
  }, []);
}

export function gainAt(t, windows, low = 0, attack = 0.06, release = 0.15) {
  let gain = 1;
  for (const window of windows) {
    if (t < window.start - attack || t > window.end + release) continue;
    const candidate = t < window.start
      ? 1 - (t - window.start + attack) / attack * (1 - low)
      : t <= window.end ? low : low + (t - window.end) / release * (1 - low);
    gain = Math.min(gain, candidate);
  }
  return Math.max(low, Math.min(1, gain));
}

export async function writeDuckingEnvelope(filePath, duration, segments, speechVolume = 0, { attack = 0.06, release = 0.15, gap = 0, invert = false } = {}) {
  const rate = 1000;
  const samples = Math.ceil(duration * rate);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  const windows = duckingWindows(segments, gap);
  const low = Math.max(0, Math.min(1, speechVolume));
  let first = 0;
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    while (first < windows.length && windows[first].end + release < t) first++;
    const active = [];
    for (let j = first; j < windows.length && windows[j].start - attack <= t; j++) active.push(windows[j]);
    const gain = gainAt(t, active, low, attack, release);
    wav.writeInt16LE(Math.round((invert ? 1 - gain : gain) * 32767), 44 + i * 2);
  }
  await writeFile(filePath, wav);
}
