import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getMediaTools, runProcess } from "../lib/media.mjs";

async function getFreePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForJob(baseUrl, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(baseUrl + "/api/jobs/" + id);
    assert.equal(response.status, 200);
    const { job } = await response.json();
    if (!["analyzing", "converting"].includes(job.status)) return job;
    await delay(100);
  }
  throw new Error("Timed out waiting for Scribe mock analysis");
}

test("local mode persists projects across restarts without saving API keys", { timeout: 30000 }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "multi-speaker-demo-smoke-"));
  const fixturePath = path.join(tempRoot, "sample.mp4");
  const { ffmpeg } = await getMediaTools();
  await runProcess(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=320x240:r=24:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart", "-y", fixturePath,
  ], 20000);

  const upstreamKeys = [];
  let musicCalls = 0;
  let musicBytes = Buffer.alloc(0);
  let musicUploadBytes = Buffer.alloc(0);
  let sttCalls = 0;
  let voiceChangerCalls = 0;
  let requiresVerification = true;
  let convertedBytes = Buffer.alloc(0);
  const upstream = createServer((req, res) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      upstreamKeys.push(req.headers["xi-api-key"] || "");
      const sendJson = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (req.method === "GET" && req.url === "/v2/voices?page_size=100&include_total_count=false") {
        sendJson(200, {
          voices: [{ voice_id: "voice-human", name: "Test Voice", category: "cloned" }],
          has_more: false,
          next_page_token: "",
        });
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/v1/shared-voices?")) {
        sendJson(200, {
          voices: [{ voice_id: "shared-test-voice", name: "Shared Voice", language: "zh", accent: "mandarin" }],
          has_more: true,
        });
        return;
      }
      if (req.method === "POST" && req.url === "/v1/music/video-to-music") {
        musicCalls++;
        musicUploadBytes = Buffer.concat(chunks);
        res.writeHead(200, { "content-type": "audio/wav" }); res.end(musicBytes); return;
      }
      if (req.method === "POST" && req.url === "/v1/speech-to-text") {
        sttCalls += 1;
        sendJson(200, {
          text: "Hello there",
          language_code: "eng",
          words: [
            { text: "Hello", start: 0.1, end: 0.45, speaker_id: "speaker_0", type: "word" },
            { text: "there", start: 0.46, end: 0.8, speaker_id: "speaker_0", type: "word" },
          ],
        });
        return;
      }
      if (req.method === "GET" && req.url === "/v1/voices/voice-human") {
        sendJson(200, {
          voice_id: "voice-human",
          name: "Restricted Test Voice",
          category: "cloned",
          voice_verification: { requires_verification: requiresVerification, is_verified: !requiresVerification },
        });
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/v1/voice-changer/")) {
        voiceChangerCalls += 1;
        res.writeHead(200, { "content-type": "audio/mpeg" });
        res.end(convertedBytes);
        return;
      }
      sendJson(404, { detail: "not found" });
    })().catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamBaseUrl = "http://127.0.0.1:" + upstream.address().port;
  const port = await getFreePort();
  const baseUrl = "http://127.0.0.1:" + port;
  const launchServer = () => spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      TMPDIR: tempRoot,
      VOICE_DEMO_DATA_DIR: path.join(tempRoot, "data"),
      VOICE_DEMO_PORT: String(port),
      ELEVENLABS_BASE_URL: upstreamBaseUrl,
      ELEVENLABS_API_KEY: "",
      LAB_API_KEY: "",
    },
    stdio: "ignore",
  });

  let server = launchServer();
  let sessionDir = path.join(tempRoot, "data");
  try {
    let started = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (server.exitCode !== null) throw new Error("Demo server exited before becoming ready");
      try {
        const response = await fetch(baseUrl + "/api/status");
        if (response.ok) {
          started = true;
          break;
        }
      } catch {}
      await delay(150);
    }
    assert.equal(started, true, "Demo server should start");

    const status = await (await fetch(baseUrl + "/api/status")).json();
    assert.equal(status.apiKeyRequired, true);
    assert.equal(status.apiKeyConfigured, undefined, "The server must not read an API key from environment variables");
    assert.equal(status.persistentStorage, true);
    assert.equal(status.host, "127.0.0.1");

    const noKeyResponse = await fetch(baseUrl + "/api/voices");
    assert.equal(noKeyResponse.status, 401);

    const key = "customer-test-key-not-for-storage";
    const voicesResponse = await fetch(baseUrl + "/api/voices", {
      headers: { "X-ElevenLabs-Api-Key": key },
    });
    assert.equal(voicesResponse.status, 200);
    assert.equal((await voicesResponse.json()).voices[0].voiceId, "voice-human");
    assert.ok(upstreamKeys.includes(key), "The backend should forward the request-scoped key to ElevenLabs");

    const sharedResponse = await fetch(baseUrl + "/api/voices?source=shared&search=Mandarin&language=zh&accent=mandarin&locale=zh-CN&page=0", {
      headers: { "X-ElevenLabs-Api-Key": key },
    });
    assert.equal(sharedResponse.status, 200);
    const sharedResult = await sharedResponse.json();
    assert.equal(sharedResult.voices[0].voiceId, "shared-test-voice");
    assert.equal(sharedResult.voices[0].labels.language, "zh");
    assert.equal(sharedResult.hasMore, true);
    assert.equal(sharedResult.nextPage, 1);

    const uploadResponse = await fetch(baseUrl + "/api/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": "sample.mp4",
      },
      body: await readFile(fixturePath),
    });
    assert.equal(uploadResponse.status, 201);
    const { job: uploadedJob } = await uploadResponse.json();
    const jobId = uploadedJob.id;

    const jobDir = path.join(sessionDir, "projects", jobId);
    const storedFiles = await readdir(jobDir);
    assert.ok(storedFiles.includes("input.mp4"));
    assert.ok(storedFiles.includes("job.json"), "Project metadata must persist");

    const analyzeWithoutKey = await fetch(baseUrl + "/api/jobs/" + jobId + "/analyze", { method: "POST" });
    assert.equal(analyzeWithoutKey.status, 401);
    assert.equal(sttCalls, 0);

    const analyzeResponse = await fetch(baseUrl + "/api/jobs/" + jobId + "/analyze", {
      method: "POST",
      headers: { "X-ElevenLabs-Api-Key": key },
    });
    assert.equal(analyzeResponse.status, 202);
    const analyzedJob = await waitForJob(baseUrl, jobId);
    assert.equal(analyzedJob.status, "ready");
    assert.equal(analyzedJob.speakers.length, 1);
    assert.equal(sttCalls, 1);

    const mappingResponse = await fetch(baseUrl + "/api/jobs/" + jobId + "/speakers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mappings: { speaker_0: "voice-human" } }),
    });
    assert.equal(mappingResponse.status, 200);

    const convertWithoutKey = await fetch(baseUrl + "/api/jobs/" + jobId + "/convert", { method: "POST" });
    assert.equal(convertWithoutKey.status, 401);

    const convertResponse = await fetch(baseUrl + "/api/jobs/" + jobId + "/convert", {
      method: "POST",
      headers: { "X-ElevenLabs-Api-Key": key },
    });
    assert.equal(convertResponse.status, 409);
    const convertPayload = await convertResponse.json();
    assert.match(convertPayload.error, /人物 01/);
    assert.match(convertPayload.error, /Restricted Test Voice/);
    assert.match(convertPayload.error, /尚未发起 Voice Changer 请求/);
    assert.equal(voiceChangerCalls, 0, "Verification preflight must block before billable generation");

    const diagnostics = await (await fetch(baseUrl + "/api/diagnostics")).json();
    assert.ok(!JSON.stringify(diagnostics).includes(key), "API keys must never enter diagnostics");

    const prematureMusic = await fetch(baseUrl + "/api/jobs/" + jobId + "/music", {
      method: "POST", headers: { "X-ElevenLabs-Api-Key": key, "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(prematureMusic.status, 409);
    assert.equal(musicCalls, 0, "Music must be blocked before voice assets are ready");
    const prematureUpload = await fetch(baseUrl + "/api/jobs/" + jobId + "/music-upload", { method: "POST", body: "not-yet" });
    assert.equal(prematureUpload.status, 409);
    requiresVerification = false;
    const generatedClip = path.join(tempRoot, "voice-fixture.mp3");
    await runProcess(ffmpeg, ["-y", "-v", "error", "-i", path.join(jobDir, "source-audio.wav"), "-c:a", "libmp3lame", generatedClip]);
    convertedBytes = await readFile(generatedClip);
    const voiceResponse = await fetch(baseUrl + "/api/jobs/" + jobId + "/convert", { method: "POST", headers: { "X-ElevenLabs-Api-Key": key } });
    assert.equal(voiceResponse.status, 202);
    const voiceJob = await waitForJob(baseUrl, jobId);
    assert.equal(voiceJob.status, "voices_ready");
    assert.equal(voiceJob.outputAvailable, false, "Voice generation must not produce a final mix");
    assert.ok(voiceJob.dialoguePreviewUrl);
    assert.ok(voiceJob.segments[0].convertedUrl);
    assert.equal((await fetch(baseUrl + voiceJob.segments[0].convertedUrl)).status, 200);
    assert.equal((await fetch(baseUrl + voiceJob.dialoguePreviewUrl)).status, 200);
    assert.equal(voiceChangerCalls, 1);
    const noDuplicate = await fetch(baseUrl + "/api/jobs/" + jobId + "/convert", { method: "POST" });
    assert.equal((await noDuplicate.json()).alreadyReady, true);
    assert.equal(voiceChangerCalls, 1);

    const mixResponse = await fetch(baseUrl + "/api/jobs/" + jobId + "/mix", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ speechVolume: 0.08, autoDucking: { normal_music_db: -5, reduction_db: 10, gap: 0.4 } }),
    });
    assert.equal(mixResponse.status, 200);
    assert.equal((await mixResponse.json()).job.speechVolume, 0.08);
    musicBytes = await readFile(path.join(jobDir, "source-audio.wav"));
    const musicResponse = await fetch(baseUrl + "/api/jobs/" + jobId + "/music", {
      method: "POST", headers: { "X-ElevenLabs-Api-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ description: "quiet strings" }),
    });
    assert.equal(musicResponse.status, 200);
    const musicJob = (await musicResponse.json()).job;
    assert.equal(musicJob.musicReady, true);
    assert.equal(musicJob.outputAvailable, false, "Preparing music must not silently compose the final video");
    assert.equal(musicJob.mixDirty, true);
    assert.equal(musicCalls, 1);
    assert.ok(musicUploadBytes.includes(await readFile(path.join(jobDir, "dialogue-preview.mp4"))), "Music generation must use the recast dialogue preview video");
    const uploadMusicResponse = await fetch(baseUrl + "/api/jobs/" + jobId + "/music-upload", {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: musicBytes,
    });
    assert.equal(uploadMusicResponse.status, 200);
    assert.equal(musicCalls, 1, "Local music upload must never call Music API");
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    assert.ok(!(await readFile(path.join(jobDir, "job.json"), "utf8")).includes(key));
    server = launchServer();
    for (let attempt = 0; attempt < 40; attempt++) {
      try { if ((await fetch(baseUrl + "/api/status")).ok) break; } catch {}
      await delay(100);
    }
    const restored = await (await fetch(baseUrl + "/api/jobs/" + jobId)).json();
    assert.equal(restored.job.speechVolume, 0.08);
    assert.equal(restored.job.musicReady, true);
    assert.equal(restored.job.musicEnabled, true);
    assert.equal(restored.job.autoDucking.normal_music_db, -5);
    const timeline = await (await fetch(baseUrl + "/api/jobs/" + jobId + "/ducking")).json();
    assert.equal(timeline.raw.length, 2);
    assert.equal(timeline.segments.length, 1);
    const invalidTimeline = await fetch(baseUrl + "/api/jobs/" + jobId + "/ducking?settings=" + encodeURIComponent(JSON.stringify({ manual_segments: [{ start: 0, end: 99 }] })));
    assert.equal(invalidTimeline.status, 400);
    assert.equal(restored.job.speakers.length, 1);
    assert.equal((await (await fetch(baseUrl + "/api/jobs")).json()).projects[0].id, jobId);

    const remixResponse = await fetch(baseUrl + "/api/jobs/" + jobId + "/remix", { method: "POST" });
    assert.equal(remixResponse.status, 200);
    const remixedJob = (await remixResponse.json()).job;
    assert.equal(remixedJob.outputAvailable, true);
    assert.equal(remixedJob.mixDirty, false);
    assert.equal(remixedJob.lastMix.musicEnabled, true);
    assert.equal(remixedJob.lastMix.autoDucking.normal_music_db, -5);
    assert.ok((await readdir(jobDir)).includes("output.mp4"));
    assert.equal(voiceChangerCalls, 1, "Final mixing must reuse the one generated voice clip");
    assert.equal(musicCalls, 1, "Remix must reuse saved music rather than regenerate it");

    const changedMix = await fetch(baseUrl + "/api/jobs/" + jobId + "/mix", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ speechVolume: 0, musicEnabled: true, autoDucking: { normal_music_db: -4, reduction_db: 6 } }),
    });
    assert.equal((await changedMix.json()).job.mixDirty, true);
    const finalResponse = await fetch(baseUrl + "/api/jobs/" + jobId + "/remix", { method: "POST" });
    const finalJob = (await finalResponse.json()).job;
    assert.equal(finalJob.mixDirty, false);
    assert.equal(finalJob.lastMix.autoDucking.reduction_db, 6);
    assert.equal(voiceChangerCalls, 1);
    assert.equal(musicCalls, 1);

    await fetch(baseUrl + "/api/jobs/" + jobId + "/speakers", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mappings: { speaker_0: "different-voice" } }),
    });
    const blockedFinal = await fetch(baseUrl + "/api/jobs/" + jobId + "/remix", { method: "POST" });
    assert.equal(blockedFinal.status, 409, "Changed voice assignments must be generated before final composition");
    assert.equal(musicCalls, 1);
    assert.equal(voiceChangerCalls, 1);

    const cleanupResponse = await fetch(baseUrl + "/api/jobs/" + jobId, { method: "DELETE" });
    assert.equal(cleanupResponse.status, 200);
    assert.ok(!(await readdir(path.join(sessionDir, "projects"))).includes(jobId));
    assert.equal((await fetch(baseUrl + "/api/jobs/" + jobId)).status, 404);
  } finally {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      delay(2500),
    ]);
    await new Promise((resolve) => upstream.close(resolve));
    const remaining = await readdir(tempRoot).catch(() => []);
    assert.ok(remaining.includes("data"), "Shutdown must retain persistent data");
    await rm(tempRoot, { recursive: true, force: true });
  }
});
