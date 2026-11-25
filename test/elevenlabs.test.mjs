import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { addSharedVoice, convertVoice, getVoiceMetadata, listSharedVoices, listVoices, transcribeWithDiarization } from "../lib/elevenlabs.mjs";

test("Speech-to-Speech sends the required multipart field named audio", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "voice-demo-sts-"));
  const filePath = path.join(directory, "sample.mp3");
  await writeFile(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x64]));

  const originalFetch = globalThis.fetch;
  let capturedRequest;
  globalThis.fetch = async (url, options) => {
    capturedRequest = { url: String(url), options };
    return new Response(Buffer.from([0xff, 0xfb, 0x90, 0x64]), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  };

  try {
    const result = await convertVoice({
      filePath,
      voiceId: "voice-target-123",
      apiKey: "test-api-key",
      baseUrl: "https://api.elevenlabs.io",
    });

    assert.equal(result.length, 4);
    assert.match(capturedRequest.url, /\/v1\/voice-changer\/voice-target-123\?/);
    assert.equal(capturedRequest.options.method, "POST");
    assert.equal(capturedRequest.options.body.has("audio"), true);
    assert.equal(capturedRequest.options.body.has("file"), false);
    assert.equal(capturedRequest.options.body.get("model_id"), "eleven_multilingual_sts_v2");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Scribe transcription continues to use the multipart field named file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "voice-demo-scribe-"));
  const filePath = path.join(directory, "sample.wav");
  await writeFile(filePath, Buffer.from("RIFF-test-audio"));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/v1\/speech-to-text$/);
    assert.equal(options.body.has("file"), true);
    assert.equal(options.body.has("audio"), false);
    assert.equal(options.body.get("diarize"), "true");
    return new Response(JSON.stringify({ words: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await transcribeWithDiarization({
      filePath,
      apiKey: "test-api-key",
      baseUrl: "https://api.elevenlabs.io",
    });
    assert.deepEqual(result, { words: [] });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads voice verification metadata before attempting a conversion", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedApiKey = "";
  globalThis.fetch = async (url, options) => {
    requestedUrl = String(url);
    requestedApiKey = options.headers["xi-api-key"];
    return new Response(JSON.stringify({
      voice_id: "voice-needs-verification",
      name: "Restricted Clone",
      category: "cloned",
      voice_verification: {
        requires_verification: true,
        is_verified: false,
      },
      safety_control: "CAPTCHA",
      is_owner: true,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await getVoiceMetadata({
      voiceId: "voice-needs-verification",
      apiKey: "test-api-key",
      baseUrl: "https://api.elevenlabs.io",
    });

    assert.equal(requestedUrl, "https://api.elevenlabs.io/v1/voices/voice-needs-verification");
    assert.equal(requestedApiKey, "test-api-key");
    assert.equal(result.requiresVerification, true);
    assert.equal(result.isVerified, false);
    assert.equal(result.name, "Restricted Clone");
    assert.equal(result.safetyControl, "CAPTCHA");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("voice library removes duplicate IDs but keeps different IDs with the same display name", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    voices: [
      { voice_id: "voice-a", name: "Rachel", category: "premade" },
      { voice_id: "voice-a", name: "Rachel duplicate entry", category: "premade" },
      { voice_id: "voice-b", name: "Rachel", category: "cloned" },
    ],
    has_more: true,
    next_page_token: "next-page",
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  try {
    const result = await listVoices({
      apiKey: "test-api-key",
      baseUrl: "https://api.elevenlabs.io",
    });

    assert.deepEqual(result.voices.map((voice) => voice.voiceId), ["voice-a", "voice-b"]);
    assert.equal(result.voices[0].name, "Rachel");
    assert.equal(result.voices[1].name, "Rachel");
    assert.equal(result.hasMore, true);
    assert.equal(result.nextPageToken, "next-page");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("shared voice library applies filters and returns page metadata", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedApiKey = "";
  globalThis.fetch = async (url, options) => {
    requestedUrl = String(url);
    requestedApiKey = options.headers["xi-api-key"];
    return new Response(JSON.stringify({
      voices: [{
        voice_id: "shared-voice-1",
        name: "Shared Mandarin Voice",
        category: "professional",
        language: "zh",
        accent: "mandarin",
        gender: "Female",
        preview_url: "https://example.test/preview.mp3",
        public_owner_id: "public-owner-1",
      }],
      has_more: true,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await listSharedVoices({
      apiKey: "test-api-key",
      baseUrl: "https://api.elevenlabs.io",
      search: "Mandarin",
      language: "zh",
      accent: "mandarin",
      locale: "zh-CN",
      page: 2,
    });
    const url = new URL(requestedUrl);
    assert.equal(url.pathname, "/v1/shared-voices");
    assert.equal(url.searchParams.get("page_size"), "100");
    assert.equal(url.searchParams.get("page"), "2");
    assert.equal(url.searchParams.get("search"), "Mandarin");
    assert.equal(url.searchParams.get("language"), "zh");
    assert.equal(url.searchParams.get("accent"), "mandarin");
    assert.equal(url.searchParams.get("locale"), "zh-CN");
    assert.equal(requestedApiKey, "test-api-key");
    assert.equal(result.voices[0].labels.language, "zh");
    assert.equal(result.voices[0].labels.accent, "mandarin");
    assert.equal(result.voices[0].publicOwnerId, "public-owner-1");
    assert.equal(result.hasMore, true);
    assert.equal(result.nextPage, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("adds a shared voice to the account before it is used for conversion", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedOptions;
  globalThis.fetch = async (url, options) => {
    requestedUrl = String(url);
    requestedOptions = options;
    return new Response(JSON.stringify({ voice_id: "account-copy-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await addSharedVoice({
      apiKey: "test-api-key",
      baseUrl: "https://api.elevenlabs.io",
      publicOwnerId: "public-owner-1",
      voiceId: "shared-voice-1",
      newName: "Shared Test Voice",
    });
    assert.equal(requestedUrl, "https://api.elevenlabs.io/v1/voices/add/public-owner-1/shared-voice-1");
    assert.equal(requestedOptions.method, "POST");
    assert.equal(requestedOptions.headers["xi-api-key"], "test-api-key");
    assert.deepEqual(JSON.parse(requestedOptions.body), { new_name: "Shared Test Voice", bookmarked: true });
    assert.deepEqual(result, { voiceId: "account-copy-1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
