import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { duckingWindows, gainAt } from "../lib/ducking.mjs";
import { composeOutputVideo, getMediaTools, runProcess } from "../lib/media.mjs";

test("ducking envelope preserves gaps and merges overlapping speech without pumping", () => {
  const windows = duckingWindows([{ start: 1, end: 2 }, { start: 1.8, end: 3 }, { start: 4, end: 5 }]);
  assert.deepEqual(windows, [{ start: 1, end: 3 }, { start: 4, end: 5 }]);
  assert.equal(gainAt(0.5, windows), 1);
  assert.equal(gainAt(1.5, windows), 0);
  assert.equal(gainAt(3.5, windows), 1);
  assert.ok(gainAt(0.97, windows) > 0 && gainAt(0.97, windows) < 1);
  assert.equal(gainAt(1.5, windows, 0.2), 0.2);
});

test("FFmpeg mix mutes original audio only inside converted windows", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "voice-ducking-test-"));
  const { ffmpeg } = await getMediaTools();
  try {
    const video = path.join(dir, "input.mp4");
    const source = path.join(dir, "source.wav");
    const clip = path.join(dir, "converted.wav");
    const output = path.join(dir, "output.mp4");
    await runProcess(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=size=160x120:duration=4", "-c:v", "libx264", video]);
    await runProcess(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", source]);
    await runProcess(ffmpeg, ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "2", clip]);
    await composeOutputVideo({ videoPath: video, sourceAudioPath: source, convertedSegments: [{ start: 1, end: 3, filePath: clip, outputDuration: 2 }], duration: 4, outputPath: output, videoCodec: "h264" });
    const volumeAt = async (start) => {
      const { stderr } = await runProcess(ffmpeg, ["-hide_banner", "-i", output, "-vn", "-af", "atrim=start=" + start + ":duration=0.4,volumedetect", "-f", "null", "-"]);
      return Number(stderr.match(/mean_volume: ([-\d.]+) dB/)?.[1]);
    };
    assert.ok(await volumeAt(0.2) > -40, "Background outside speech must remain audible");
    assert.ok(await volumeAt(1.5) < -70, "Default 0% must remove the original voice inside speech");
    assert.ok(await volumeAt(3.5) > -40, "Background must return after release");
    await composeOutputVideo({ videoPath: video, sourceAudioPath: source, convertedSegments: [{ id: "s1", start: 1, end: 3, filePath: clip, outputDuration: 2 }], duration: 4, outputPath: output, videoCodec: "h264", musicPath: source });
    const musicGap = await volumeAt(0.2);
    const musicSpeech = await volumeAt(1.5);
    assert.ok(musicGap > -35 && musicGap < -15, "Music mode must replace, rather than double, the original background");
    assert.ok(musicSpeech > -50, "New background music must remain audible under speech");
    assert.ok(musicSpeech < musicGap - 5, "Music must duck beneath speech");

  } finally { await rm(dir, { recursive: true, force: true }); }
});
