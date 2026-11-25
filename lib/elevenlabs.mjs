import { readFile } from "node:fs/promises";
import path from "node:path";

function requireApiKey(apiKey) {
  if (!apiKey) throw new Error("请先在页面填写并验证 ElevenLabs API Key");
}

async function readError(response) {
  const body = await response.text().catch(() => "");
  let message = body;
  try {
    const parsed = JSON.parse(body);
    message = parsed.detail?.message ?? parsed.detail ?? parsed.message ?? body;
  } catch {
    // Keep the plain response body.
  }
  return "ElevenLabs API " + response.status + "：" + String(message).slice(0, 700);
}

export async function transcribeWithDiarization({ filePath, apiKey, baseUrl, maxSpeakers = 8 }) {
  requireApiKey(apiKey);
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), path.basename(filePath));
  form.append("model_id", "scribe_v3");
  form.append("diarize", "true");
  form.append("num_speakers", String(maxSpeakers));
  form.append("timestamps_granularity", "word");
  form.append("tag_audio_events", "true");

  const response = await fetch(baseUrl + "/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export async function convertVoice({ filePath, voiceId, apiKey, baseUrl }) {
  requireApiKey(apiKey);
  if (!voiceId) throw new Error("缺少目标 Voice ID");
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append("audio", new Blob([bytes], { type: "audio/mpeg" }), path.basename(filePath));
  form.append("model_id", "eleven_multilingual_sts_v2");
  form.append("remove_background_noise", "true");

  const response = await fetch(
    baseUrl + "/v1/voice-changer/" + encodeURIComponent(voiceId) + "?output_format=mp3_44100_128",
    {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
      signal: AbortSignal.timeout(5 * 60 * 1000),
    },
  );
  if (!response.ok) throw new Error(await readError(response));
  return Buffer.from(await response.arrayBuffer());
}

export async function getVoiceMetadata({ voiceId, apiKey, baseUrl }) {
  requireApiKey(apiKey);
  if (!voiceId) throw new Error("缺少目标 Voice ID");
  const response = await fetch(baseUrl + "/v1/voices/" + encodeURIComponent(voiceId), {
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(await readError(response));
  const voice = await response.json();
  const verification = voice.voice_verification ?? {};
  return {
    voiceId: voice.voice_id ?? voiceId,
    name: voice.name ?? voiceId,
    category: voice.category ?? "",
    requiresVerification: voice.requires_verification === true || verification.requires_verification === true,
    isVerified: verification.is_verified === true,
    safetyControl: voice.safety_control ?? null,
    isOwner: voice.is_owner ?? null,
  };
}

export async function listVoices({ apiKey, baseUrl, search = "", pageToken = "" }) {
  requireApiKey(apiKey);
  const params = new URLSearchParams({ page_size: "100", include_total_count: "false" });
  if (search) params.set("search", search);
  if (pageToken) params.set("next_page_token", pageToken);

  const response = await fetch(baseUrl + "/v2/voices?" + params.toString(), {
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json();
  const uniqueVoices = new Map();
  for (const voice of payload.voices ?? []) {
    const voiceId = String(voice.voice_id ?? "").trim();
    if (!voiceId || uniqueVoices.has(voiceId)) continue;
    uniqueVoices.set(voiceId, {
      voiceId,
      name: voice.name ?? voiceId,
      category: voice.category ?? "",
      description: voice.description ?? "",
      labels: voice.labels ?? {},
      previewUrl: voice.preview_url ?? "",
    });
  }
  return {
    voices: [...uniqueVoices.values()],
    hasMore: Boolean(payload.has_more),
    nextPageToken: payload.next_page_token ?? "",
  };
}

export async function listSharedVoices({ apiKey, baseUrl, search = "", language = "", accent = "", locale = "", page = 0 }) {
  requireApiKey(apiKey);
  const params = new URLSearchParams({ page_size: "100", page: String(Math.max(0, Number(page) || 0)) });
  if (search) params.set("search", search);
  if (language) params.set("language", language);
  if (accent) params.set("accent", accent);
  if (locale) params.set("locale", locale);

  const response = await fetch(baseUrl + "/v1/shared-voices?" + params.toString(), {
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json();
  const uniqueVoices = new Map();
  for (const voice of payload.voices ?? []) {
    const voiceId = String(voice.voice_id ?? "").trim();
    if (!voiceId || uniqueVoices.has(voiceId)) continue;
    uniqueVoices.set(voiceId, {
      voiceId,
      name: voice.name ?? voiceId,
      category: voice.category ?? "shared",
      description: voice.description ?? "",
      labels: {
        accent: voice.accent ?? "",
        gender: voice.gender ?? "",
        age: voice.age ?? "",
        language: voice.language ?? "",
        use_case: voice.use_case ?? "",
      },
      previewUrl: voice.preview_url ?? "",
      publicOwnerId: voice.public_owner_id ?? "",
    });
  }
  return {
    voices: [...uniqueVoices.values()],
    hasMore: Boolean(payload.has_more),
    nextPage: Math.max(0, Number(page) || 0) + 1,
  };
}

export async function addSharedVoice({ apiKey, baseUrl, publicOwnerId, voiceId, newName }) {
  requireApiKey(apiKey);
  if (!publicOwnerId || !voiceId || !newName) throw new Error("共享音色缺少添加所需的信息");
  const response = await fetch(
    baseUrl + "/v1/voices/add/" + encodeURIComponent(publicOwnerId) + "/" + encodeURIComponent(voiceId),
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: newName, bookmarked: true }),
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json();
  if (!payload.voice_id) throw new Error("ElevenLabs 未返回已添加音色的 Voice ID");
  return { voiceId: String(payload.voice_id) };
}
