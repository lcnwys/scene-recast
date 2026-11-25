// Optional real-browser smoke check using the project's installed playwright-cli wrapper.
// Does not upload videos or invoke billable ElevenLabs generation requests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { getMediaTools, runProcess } from "../lib/media.mjs";

const wrapper = path.join(os.homedir(), ".codex/skills/playwright/scripts/playwright_cli.sh");
const npmCache = fs.mkdtempSync(path.join(os.tmpdir(), "multi-speaker-pw-npm-"));
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-speaker-demo-browser-"));
if (!fs.existsSync(wrapper)) {
  console.log("SKIP: playwright-cli wrapper not installed; HTTP + synthetic browser tests still run via npm test.");
  process.exit(0);
}

// Synthetic persisted project verifies stage ordering without cloud API calls or private media.
const fixtureId = "11111111-1111-4111-8111-111111111111";
const fixtureDir = path.join(tempDataDir, "projects", fixtureId);
fs.mkdirSync(path.join(fixtureDir, "segments"), { recursive: true });
const { ffmpeg } = await getMediaTools();
await runProcess(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=24:d=2", "-c:v", "libx264", path.join(fixtureDir, "input.mp4")]);
await runProcess(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", path.join(fixtureDir, "segments", "demo.mp3")]);
fs.copyFileSync(path.join(fixtureDir, "segments", "demo.mp3"), path.join(fixtureDir, "background-music.mp3"));
const segments = Array.from({ length: 3 }, (_, i) => ({ id: "seg-000" + (i + 1), speakerId: "speaker_" + i, start: i * 0.6, end: i * 0.6 + 0.5, speechStart: i * 0.6, speechEnd: i * 0.6 + 0.5, text: "Synthetic line " + (i + 1), wordCount: 1, status: "completed", convertedFile: "demo.mp3" }));
fs.writeFileSync(path.join(fixtureDir, "job.json"), JSON.stringify({
  id: fixtureId, status: "voices_ready", createdAt: new Date().toISOString(), inputFileName: "Synthetic workflow fixture.mp4", inputExtension: ".mp4", media: { duration: 2, width: 320, height: 240, videoCodec: "h264" },
  speakers: segments.map((s, i) => ({ speakerId: s.speakerId, label: "Demo speaker " + (i + 1) })), segments,
  voiceMappings: Object.fromEntries(segments.map((s, i) => [s.speakerId, "test-voice-" + i])), analysisProgress: 100, conversionProgress: { total: 3, completed: 3, failed: 0, percent: 100 },
  outputAvailable: false, mixDirty: true, musicReady: true, musicEnabled: true, warnings: [],
}));

const port = 3230 + (process.pid % 100);
const baseUrl = "http://127.0.0.1:" + port;
const session = "multi-speaker-demo-" + process.pid;
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, VOICE_DEMO_PORT: String(port), VOICE_DEMO_HOST: "127.0.0.1", VOICE_DEMO_DATA_DIR: tempDataDir },
  stdio: "ignore",
});
const output = [];

function cli(...args) {
  const result = spawnSync(wrapper, ["-s=" + session, ...args], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, npm_config_cache: npmCache },
    encoding: "utf8",
    timeout: 35000,
  });
  if (result.error || result.status !== 0) {
    throw new Error("playwright-cli " + args[0] + " failed: " + (result.stderr || result.stdout || result.error).slice(-1200));
  }
  output.push(args[0] + " ok");
  return result.stdout || "";
}

function evalJson(expression) {
  const stdout = cli("eval", expression);
  const raw = stdout.split("### Result\n")[1]?.split("\n")[0];
  if (!raw) throw new Error("Unexpected playwright-cli eval output: " + stdout.slice(-600));
  let parsed = JSON.parse(raw);
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch {}
  }
  return parsed;
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    if (server.exitCode !== null) throw new Error("Demo server exited before ready");
    try {
      const r = await fetch(baseUrl + "/api/status");
      if (r.ok) { ready = true; break; }
    } catch {}
    await delay(250);
  }
  assert.ok(ready, "demo server failed to start");
  cli("open", baseUrl + "/?job=" + fixtureId);
  const page = evalJson("() => JSON.stringify({ title: document.title, appReady: window.__voiceDemoAppBootstrapped === true, debugButton: !!document.querySelector('#debugOpenButton') })");
  assert.match(page.title, /SceneRecast/);
  assert.equal(page.appReady, true, "main app failed to initialize");
  assert.equal(page.debugButton, true);

  const workflow = evalJson(`async () => {
    for (let i = 0; i < 40 && document.querySelector('#voiceClips').children.length !== 3; i++) await new Promise(r => setTimeout(r, 100));
    const voice = document.querySelector('#conversionPanel'), music = document.querySelector('#musicPanel'), final = document.querySelector('#finalMixPanel');
    return JSON.stringify({ clips: document.querySelector('#voiceClips').children.length, voiceBeforeMusic: !!(voice.compareDocumentPosition(music) & Node.DOCUMENT_POSITION_FOLLOWING), musicBeforeFinal: !!(music.compareDocumentPosition(final) & Node.DOCUMENT_POSITION_FOLLOWING), musicVisible: !music.hidden, finalVisible: !final.hidden, convertDisabled: document.querySelector('#convertButton').disabled, finalEnabled: !document.querySelector('#remixButton').disabled, resultHidden: document.querySelector('#comparePanel').hidden, summary: document.querySelector('#finalAssetSummary').textContent });
  }`);
  assert.equal(workflow.clips, 3);
  assert.equal(workflow.voiceBeforeMusic, true);
  assert.equal(workflow.musicBeforeFinal, true);
  assert.equal(workflow.musicVisible, true);
  assert.equal(workflow.finalVisible, true);
  assert.equal(workflow.convertDisabled, true);
  assert.equal(workflow.finalEnabled, true);
  assert.equal(workflow.resultHidden, true, "Saved materials must not be displayed as a final result");
  assert.match(workflow.summary, /已保存音乐/);
  const toggled = evalJson("() => { document.querySelector('#musicEnabled').click(); return JSON.stringify({summary:document.querySelector('#finalAssetSummary').textContent, resultHidden:document.querySelector('#comparePanel').hidden}); }");
  assert.match(toggled.summary, /不加新音乐/);
  assert.equal(toggled.resultHidden, true);
  const preset = evalJson("() => { document.querySelector('#resetDuckingButton').click(); return JSON.stringify({level:document.querySelector('#musicLevel').value,reduction:document.querySelector('#musicReduction').value,message:document.querySelector('#musicSpeechLevel').textContent}); }");
  assert.equal(preset.level, "-6"); assert.equal(preset.reduction, "8"); assert.match(preset.message, /-14/);

  const opened = evalJson("() => { document.querySelector('#debugOpenButton').click(); return JSON.stringify({ visible: !document.querySelector('#debugPanel').hidden }); }");
  assert.equal(opened.visible, true);

  const caught = evalJson("() => { window.dispatchEvent(new ErrorEvent('error', {message: 'DEMO_BROWSER_SMOKE_ERROR', filename: location.origin + '/assets/app.js', lineno: 37, colno: 4})); return JSON.stringify({ hasError: document.querySelector('#debugOpenButton').dataset.hasError === 'true' }); }");
  assert.equal(caught.hasError, true);

  const refreshed = evalJson("async () => { await window.demoDiagnostics.refresh(); return JSON.stringify({ hasEvent: document.querySelector('#debugLogList').textContent.includes('DEMO_BROWSER_SMOKE_ERROR') }); }");
  assert.equal(refreshed.hasEvent, true);
  console.log("真实浏览器验收通过：配音→配乐→最终合成顺序、素材试听、最终素材摘要、诊断与异常捕获");
} finally {
  try { cli("close"); } catch {}
  server.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(1500)]);
  fs.rmSync(npmCache, { recursive: true, force: true });
  fs.rmSync(tempDataDir, { recursive: true, force: true });
}
