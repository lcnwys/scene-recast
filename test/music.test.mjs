import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateBackgroundMusic } from "../lib/music.mjs";

test("video scoring sends one explicit music request without audio reference or SFX", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "voice-score-test-"));
  const videoPath = path.join(dir, "input.mp4");
  const originalFetch = globalThis.fetch;
  await writeFile(videoPath, "test-video");
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.elevenlabs.io/v1/music/video-to-music");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["xi-api-key"], "test-key");
    assert.equal(options.body.get("videos").name, "source-video.mp4");
    assert.equal(options.body.get("model_id"), "music_v2_5");
    assert.equal(options.body.get("use_audio_as_reference"), "false");
    assert.equal(options.body.get("add_sfx"), "false");
    assert.equal(options.body.get("separate_tracks"), "false");
    assert.match(options.body.get("description"), /No vocals/);
    return new Response("mock-mp3", { headers: { "content-type": "audio/mpeg" } });
  };
  try {
    assert.equal((await generateBackgroundMusic({ videoPath, apiKey: "test-key", baseUrl: "https://api.elevenlabs.io" })).toString(), "mock-mp3");
    assert.equal(calls, 1);
    globalThis.fetch = async () => new Response("private content", { status: 403 });
    await assert.rejects(generateBackgroundMusic({ videoPath, apiKey: "test-key", baseUrl: "https://api.elevenlabs.io" }), /HTTP 403/);
  } finally { globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); }
});
