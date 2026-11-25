import { createServer } from "node:http";
import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createDiagnostics } from "./lib/diagnostics.mjs";
import { buildSpeakerSegments, getTempoAdjustment, validateSpeakerMappings } from "./lib/segments.mjs";
import {
  composeOutputVideo,
  extractAudioTracks,
  extractSegment,
  getMediaTools,
  probeDuration,
  probeMedia,
  runProcess,
} from "./lib/media.mjs";
import {
  addSharedVoice,
  convertVoice,
  getVoiceMetadata,
  listSharedVoices,
  listVoices,
  transcribeWithDiarization,
} from "./lib/elevenlabs.mjs";

import { autoDucking, duckingSettings } from "./lib/auto-ducking.mjs";
import { generateBackgroundMusic } from "./lib/music.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, "public");
const DATA_DIR = path.resolve(process.env.VOICE_DEMO_DATA_DIR || path.join(APP_DIR, "data"));
const JOBS_DIR = path.join(DATA_DIR, "projects");
const diagnostics = createDiagnostics(path.join(DATA_DIR, "logs", "diagnostics.jsonl"));
const clientRates = new Map();
const jobs = new Map();
const pendingSaves = new Map();

function trace(event) {
  void diagnostics.append(event).catch((error) => {
    process.stderr.write("[voice-demo diagnostics] " + error.message + "\\n");
  });
}
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 10 * 60;
const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm"]);

function apiConfig(req) {
  return {
    apiKey: String(req?.headers?.["x-elevenlabs-api-key"] ?? "").trim(),
    baseUrl: (process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io").replace(/\/$/, ""),
  };
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function cleanSpeechText(text) {
  return String(text ?? "").replace(/\[[^\]]*\]|【[^】]*】/g, "").trim();
}

function isSpeechSegment(segment) {
  if (!(Number(segment.wordCount) > 0)) return false;
  // Old Scribe runs sometimes classified "[背景音乐][喘气声]" as word tokens.
  // Ignore annotation-only clips when resuming those jobs, without losing spoken text.
  return cleanSpeechText(segment.text).length > 0;
}

function speechData(job) {
  const segments = (job.segments ?? [])
    .filter(isSpeechSegment)
    .map((segment) => ({ ...segment, text: cleanSpeechText(segment.text) }));
  const activeSpeakerIds = new Set(segments.map((segment) => segment.speakerId));
  const speakers = (job.speakers ?? [])
    .filter((speaker) => activeSpeakerIds.has(speaker.speakerId))
    .map((speaker) => {
      const ownSegments = segments.filter((segment) => segment.speakerId === speaker.speakerId);
      const sample = ownSegments.find((segment) => !segment.overlap && !segment.short) ?? ownSegments[0] ?? null;
      return {
        ...speaker,
        segmentCount: ownSegments.length,
        wordCount: ownSegments.reduce((sum, segment) => sum + (Number(segment.wordCount) || 0), 0),
        firstSeen: ownSegments[0]?.speechStart ?? speaker.firstSeen ?? 0,
        sampleSegmentId: sample?.id ?? null,
        sampleText: sample?.text ?? "",
      };
    });
  const voiceMappings = Object.fromEntries(
    speakers.map((speaker) => [
      speaker.speakerId,
      job.voiceMappings?.[speaker.speakerId] ?? speaker.voiceId ?? "",
    ]),
  );
  return { speakers, segments, voiceMappings };
}

function publicJob(job) {
  const speech = speechData(job);
  const eligibleSegments = speech.segments.filter((segment) => !segment.overlap);
  const completed = eligibleSegments.filter((segment) => segment.status === "completed").length;
  const failed = eligibleSegments.filter((segment) => segment.status === "failed").length;
  const conversionProgress = job.conversionProgress
    ? {
        ...job.conversionProgress,
        total: eligibleSegments.length,
        completed,
        failed,
        skippedOverlap: speech.segments.filter((segment) => segment.overlap).length,
        skippedNonSpeech: (job.segments ?? []).length - speech.segments.length,
        percent: eligibleSegments.length ? Math.round(((completed + failed) / eligibleSegments.length) * 100) : 0,
      }
    : job.conversionProgress;
  return {
    id: job.id,
    status: job.status,
    inputFileName: job.inputFileName,
    createdAt: job.createdAt,
    media: job.media,
    analysisProgress: job.analysisProgress,
    conversionProgress,
    transcriptLanguage: job.transcriptLanguage,
    transcriptText: job.transcriptText,
    speakers: speech.speakers,
    segments: speech.segments.map((segment) => ({ ...segment, convertedUrl: segment.status === "completed" && segment.convertedFile ? "/api/jobs/" + job.id + "/segment/" + segment.id + "/converted" : "" })),
    unassignedWordCount: job.unassignedWordCount,
    voiceMappings: speech.voiceMappings,
    outputAvailable: job.outputAvailable,
    mixDirty: Boolean(job.mixDirty),
    dialoguePreviewUrl: job.dialoguePreviewAvailable ? "/api/jobs/" + job.id + "/file/dialogue" : "",
    musicEnabled: Boolean(job.musicEnabled),
    musicReady: Boolean(job.musicReady),
    autoDucking: duckingSettings(job.autoDucking, job.media.duration),
    musicDescription: job.musicDescription || "",
    musicReferenceAudio: Boolean(job.musicReferenceAudio),
    musicError: job.musicError || "",
    lastMix: job.lastMix || null,
    musicUrl: job.musicReady ? "/api/jobs/" + job.id + "/file/music" : "",
    speechVolume: job.speechVolume ?? 0,
    storagePath: "data/projects/" + job.id,
    warnings: job.warnings,
    error: job.error,
    analysisError: job.analysisError,
    conversionError: job.conversionError,
    originalUrl: "/api/jobs/" + job.id + "/file/original",
    outputUrl: job.outputAvailable && !job.mixDirty ? "/api/jobs/" + job.id + "/file/output" : "",
  };
}

function completedClips(job) {
  return job.segments.filter((segment) => segment.status === "completed" && segment.convertedFile)
    .map((segment) => ({ ...segment, filePath: path.join(jobDirectory(job.id), "segments", segment.convertedFile) }));
}

function voiceStageReady(job) {
  return completedClips(job).length > 0 && !job.segments.filter(isSpeechSegment).some((segment) => !segment.overlap && !["completed", "failed"].includes(segment.status));
}

async function ensureDialoguePreview(job) {
  const dir = jobDirectory(job.id);
  if (!completedClips(job).length) throw Object.assign(new Error("请先完成配音片段，再添加配乐"), { statusCode: 409 });
  if (!job.dialoguePreviewAvailable) {
    await composeOutputVideo({ videoPath: path.join(dir, "input" + job.inputExtension), sourceAudioPath: path.join(dir, "source-audio.wav"), convertedSegments: completedClips(job), duration: job.media.duration, outputPath: path.join(dir, "dialogue-preview.mp4"), videoCodec: job.media.videoCodec, dialogueOnly: true, speechSegments: job.segments.filter(isSpeechSegment) });
    job.dialoguePreviewAvailable = true;
  }
  return path.join(dir, "dialogue-preview.mp4");
}

function musicMixOptions(job) {
  return {
    musicPath: job.musicEnabled && job.musicReady ? path.join(jobDirectory(job.id), "background-music.mp3") : "",
    speechSegments: job.segments.filter(isSpeechSegment),
    autoDuckingSettings: duckingSettings(job.autoDucking, job.media.duration),
    speechWords: job.speechWords || [],
  };
}

function jobDirectory(id) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    const error = new Error("无效的任务编号");
    error.statusCode = 400;
    throw error;
  }
  return path.join(JOBS_DIR, id);
}

async function readJob(id) {
  const job = jobs.get(id);
  if (!job) {
    const notFound = new Error("找不到该视频项目，可能已被手动删除。");
    notFound.statusCode = 404;
    throw notFound;
  }
  job._lastAccessAt = Date.now();
  return job;
}

async function saveJob(job) {
  job._lastAccessAt = Date.now();
  jobs.set(job.id, job);
  const snapshot = JSON.stringify(job, (key, value) => key.startsWith("_") ? undefined : value, 2);
  const pending = (pendingSaves.get(job.id) || Promise.resolve()).catch(() => {}).then(async () => {
    const dir = jobDirectory(job.id);
    await fs.mkdir(dir, { recursive: true });
    const temporary = path.join(dir, "job.json.tmp");
    await fs.writeFile(temporary, snapshot, { mode: 0o600 });
    await fs.rename(temporary, path.join(dir, "job.json"));
  });
  pendingSaves.set(job.id, pending);
  await pending;
}

async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("请求内容过大");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("JSON 格式无效");
    error.statusCode = 400;
    throw error;
  }
}

async function streamUpload(req, filePath, maxBytes = MAX_UPLOAD_BYTES) {
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (declaredLength > maxBytes) {
    const error = new Error("文件超过上传大小限制");
    error.statusCode = 413;
    throw error;
  }

  const output = createWriteStream(filePath, { flags: "wx" });
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("文件超过上传大小限制");
        error.statusCode = 413;
        throw error;
      }
      if (!output.write(chunk)) await once(output, "drain");
    }
    const finished = once(output, "finish");
    output.end();
    await finished;
  } catch (error) {
    output.destroy();
    throw error;
  }
  if (size < 1024) {
    const error = new Error("上传文件为空或内容不完整");
    error.statusCode = 400;
    throw error;
  }
  return size;
}

async function sendFileRange(req, res, filePath, contentType) {
  const info = await fs.stat(filePath);
  const range = req.headers.range;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, no-store");

  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      res.writeHead(416, { "Content-Range": "bytes */" + info.size });
      res.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      res.writeHead(416, { "Content-Range": "bytes */" + info.size });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Range": "bytes " + start + "-" + end + "/" + info.size,
      "Content-Length": end - start + 1,
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { "Content-Length": info.size });
  createReadStream(filePath).pipe(res);
}

async function createJob(req, res) {
  const rawName = decodeURIComponent(String(req.headers["x-file-name"] ?? "source.mp4"));
  const extension = path.extname(rawName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    json(res, 415, { error: "目前支持 MP4、MOV、M4V、MKV、WebM 视频" });
    return;
  }

  const id = randomUUID();
  const dir = jobDirectory(id);
  await fs.mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, "input" + extension);

  try {
    const size = await streamUpload(req, inputPath);
    const media = await probeMedia(inputPath);
    if (media.duration > MAX_VIDEO_SECONDS) {
      const error = new Error("第一版单个视频最长支持 10 分钟");
      error.statusCode = 413;
      throw error;
    }

    const job = {
      id,
      status: "uploaded",
      createdAt: new Date().toISOString(),
      inputFileName: path.basename(rawName).slice(0, 160),
      inputExtension: extension,
      inputBytes: size,
      media,
      analysisProgress: 0,
      conversionProgress: null,
      transcriptLanguage: "",
      transcriptText: "",
      speakers: [],
      segments: [],
      unassignedWordCount: 0,
      voiceMappings: {},
      speechVolume: 0,
      outputAvailable: false,
      warnings: [],
      error: "",
      analysisError: "",
      conversionError: "",
    };
    await saveJob(job);
    trace({ level: "info", event: "job_created", stage: "upload", jobId: id, message: "视频上传及媒体检查完成", durationMs: Math.round(media.duration * 1000) });
    json(res, 201, { job: publicJob(job) });
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function runAnalysis(job, apiKey, baseUrl) {
  const dir = jobDirectory(job.id);
  const inputPath = path.join(dir, "input" + job.inputExtension);
  const sourceAudioPath = path.join(dir, "source-audio.wav");
  const sttAudioPath = path.join(dir, "stt-audio.wav");

  try {
    job.status = "analyzing";
    job.analysisProgress = 8;
    job.error = "";
    job.analysisError = "";
    trace({ level: "info", event: "analysis_started", stage: "analysis", jobId: job.id, message: "开始提取音频并准备转录" });
    await saveJob(job);

    await extractAudioTracks(inputPath, sourceAudioPath, sttAudioPath);
    job.analysisProgress = 35;
    await saveJob(job);
    trace({ level: "info", event: "audio_extracted", stage: "ffmpeg", jobId: job.id, message: "音频提取成功，即将请求 Scribe v3" });

    const transcript = await transcribeWithDiarization({
      filePath: sttAudioPath,
      apiKey,
      baseUrl,
      maxSpeakers: 8,
    });
    job.analysisProgress = 82;
    await saveJob(job);
    trace({ level: "info", event: "stt_completed", stage: "scribe", jobId: job.id, message: "Scribe 转录已返回" });

    job.speechWords = transcript.words ?? [];
    const diarization = buildSpeakerSegments(job.speechWords, job.media.duration);
    job.transcriptText = String(transcript.text ?? "");
    job.transcriptLanguage = String(transcript.language_code ?? "");
    job.speakers = diarization.speakers.map((speaker, index) => ({
      ...speaker,
      label: "人物 " + String(index + 1).padStart(2, "0"),
    }));
    job.segments = diarization.segments;
    job.unassignedWordCount = diarization.unassignedWordCount;
    job.warnings = [];
    if (job.speakers.length < 4) {
      job.warnings.push("本次识别到 " + job.speakers.length + " 位说话人，少于第一版目标的 4 位；请核对是否有漏识别或人物被合并");
    }
    if (job.unassignedWordCount) {
      job.warnings.push(job.unassignedWordCount + " 个词没有 speaker_id，未自动分配到人物");
    }
    const overlapCount = job.segments.filter((segment) => segment.overlap).length;
    if (overlapCount) {
      job.warnings.push(overlapCount + " 个语句片段存在多人重叠，第一版不会自动转换这些片段");
    }

    job.analysisProgress = 100;
    job.status = job.speakers.length ? "ready" : "failed";
    if (!job.speakers.length) {
      job.analysisError = "Scribe v3 没有返回可用的 speaker_id。请检查音频或重新上传素材";
      job.error = job.analysisError;
    }
    await saveJob(job);
    trace({ level: job.status === "ready" ? "info" : "warn", event: "analysis_finished", stage: "analysis", jobId: job.id, message: "识别说话人 " + job.speakers.length + " 位，片段 " + job.segments.length + " 段" });
  } catch (error) {
    trace({ level: "error", event: "analysis_failed", stage: "analysis", jobId: job.id, message: error.message, stack: error.stack });
    job.status = "failed";
    job.analysisError = error.message;
    job.error = error.message;
    await saveJob(job);
  }
}

function startAnalysis(job, apiKey, baseUrl) {
  void runAnalysis(job, apiKey, baseUrl);
}

async function processSegment(job, segment, segmentDir, apiKey, baseUrl) {
  const voiceId = job.voiceMappings?.[segment.speakerId];
  if (!voiceId) throw new Error("该人物尚未配置目标音色");

  const sourceClip = path.join(segmentDir, segment.id + "-source.mp3");
  const convertedClip = path.join(segmentDir, segment.id + "-converted.mp3");
  const start = segment.start;
  const duration = segment.end - segment.start;

  await extractSegment(path.join(jobDirectory(job.id), "source-audio.wav"), start, duration, sourceClip);
  const converted = await convertVoice({
    filePath: sourceClip,
    voiceId,
    apiKey,
    baseUrl,
  });
  await fs.writeFile(convertedClip, converted);
  const outputDuration = await probeDuration(convertedClip);
  if (!(outputDuration > 0)) throw new Error("变声结果时长无效");
  const timing = getTempoAdjustment(outputDuration, duration);

  segment.convertedFile = segment.id + "-converted.mp3";
  segment.outputDuration = outputDuration;
  segment.tempo = timing.tempo;
  segment.timingWarning = timing.warning;
  segment.status = "completed";
  segment.error = "";
}

async function runConversion(job, apiKey, baseUrl) {
  const dir = jobDirectory(job.id);
  const segmentDir = path.join(dir, "segments");
  await fs.mkdir(segmentDir, { recursive: true });

  // Historical jobs may contain music/SFX-only segments; never send these to STS.
  const speechSegments = job.segments.filter(isSpeechSegment);
  const eligible = speechSegments.filter((segment) => !segment.overlap);
  const skippedOverlap = speechSegments.filter((segment) => segment.overlap).length;
  const skippedNonSpeech = job.segments.length - speechSegments.length;
  for (const segment of job.segments) {
    if (!isSpeechSegment(segment)) {
      segment.status = "skipped_non_speech";
      segment.error = "";
    }
  }
  const pending = eligible.filter((segment) => segment.status !== "completed");
  let completed = eligible.filter((segment) => segment.status === "completed").length;
  let failed = 0;
  let fatalError = "";
  trace({ level: "info", event: "conversion_started", stage: "voice_changer", jobId: job.id, message: "待处理片段 " + pending.length + " 段，已缓存 " + completed + " 段" });

  job.status = "converting";
  job.conversionError = "";
  job.error = "";
  job.conversionProgress = {
    total: eligible.length,
    completed,
    failed: 0,
    skippedOverlap,
    skippedNonSpeech,
    percent: eligible.length ? Math.round((completed / eligible.length) * 100) : 0,
  };
  await saveJob(job);

  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < pending.length && !fatalError) {
      const segment = pending[nextIndex];
      nextIndex += 1;
      segment.status = "processing";
      segment.error = "";
      await saveJob(job);

      try {
        await processSegment(job, segment, segmentDir, apiKey, baseUrl);
        completed += 1;
        trace({ level: "info", event: "segment_completed", stage: "voice_changer", jobId: job.id, segmentId: segment.id, speakerId: segment.speakerId, message: "片段转换成功" });
      } catch (error) {
        failed += 1;
        segment.status = "failed";
        segment.error = error.message;
        trace({ level: "error", event: "segment_failed", stage: "voice_changer", jobId: job.id, segmentId: segment.id, speakerId: segment.speakerId, message: error.message, stack: error.stack });
        if (/ElevenLabs API (401|403|429)/.test(error.message)) fatalError = error.message;
      }

      job.conversionProgress = {
        total: eligible.length,
        completed,
        failed,
        skippedOverlap,
        skippedNonSpeech,
        percent: eligible.length ? Math.round(((completed + failed) / eligible.length) * 100) : 100,
      };
      await saveJob(job);
    }
  };

  await Promise.all(Array.from({ length: Math.min(2, pending.length) }, () => worker()));

  const convertedSegments = job.segments
    .filter((segment) => segment.status === "completed" && segment.convertedFile)
    .map((segment) => ({
      ...segment,
      filePath: path.join(segmentDir, segment.convertedFile),
    }));

  if (!convertedSegments.length) {
    job.status = "failed";
    job.conversionError = fatalError || "没有成功生成可合成的变声音频片段";
    trace({ level: "error", event: "conversion_no_output", stage: "voice_changer", jobId: job.id, message: job.conversionError });
    job.error = job.conversionError;
    await saveJob(job);
    return;
  }

  job.mixDirty = true;
  job.outputAvailable = false;
  job.dialoguePreviewAvailable = false;
  try {
    await ensureDialoguePreview(job);
    job.status = "voices_ready";
    if (fatalError) job.conversionError = fatalError;
    else if (failed) job.conversionError = failed + " 个片段失败，可重试；最终合成会保留这些区间的原声";
    else if (job.conversionProgress.skippedOverlap) job.conversionError = "多人重叠片段已跳过，最终合成会保留原声";
    job.error = "";
    trace({ level: "info", event: "voices_ready", stage: "voice_changer", jobId: job.id, message: "配音素材与无配乐预览已就绪，请继续添加配乐并最终合成" });
  } catch (error) {
    job.status = "failed"; job.conversionError = error.message;
  }
  await saveJob(job);
}

async function startConversion(job, res, apiKey, baseUrl) {
  if (["converting", "scoring"].includes(job.status)) {
    json(res, 409, { error: "该任务正在变声处理中" });
    return;
  }
  const speech = speechData(job);
  if (!speech.speakers.length || !speech.segments.length) {
    json(res, 409, { error: "没有识别到有效人声片段，请检查转录结果" });
    return;
  }
  const validation = validateSpeakerMappings(speech.speakers, speech.voiceMappings);
  if (!validation.valid) {
    json(res, 400, { error: validation.errors.join("；"), details: validation.errors });
    return;
  }
  if (speech.segments.some((segment) => !segment.overlap) && speech.segments.filter((segment) => !segment.overlap).every((segment) => segment.status === "completed")) {
    json(res, 200, { job: publicJob(job), alreadyReady: true }); return;
  }
  if (!apiKey) {
    json(res, 401, { error: "请先在页面填写并验证 ElevenLabs API Key" });
    return;
  }

  let voiceChecks;
  try {
    voiceChecks = await Promise.all(speech.speakers.map(async (speaker) => ({
      speaker,
      voice: await getVoiceMetadata({
        voiceId: speech.voiceMappings[speaker.speakerId],
        apiKey,
        baseUrl,
      }),
    })));
  } catch (error) {
    trace({
      level: "error",
      event: "voice_preflight_failed",
      stage: "voice_verification",
      jobId: job.id,
      message: error.message,
    });
    json(res, 502, {
      error: "无法读取目标音色的验证状态：" + error.message + "。为避免无效调用，本次尚未发起 Voice Changer 请求。",
    });
    return;
  }

  const blockedVoices = voiceChecks.filter(({ voice }) =>
    voice.requiresVerification && !voice.isVerified,
  );
  if (blockedVoices.length) {
    const details = blockedVoices.map(({ speaker, voice }) => ({
      speakerId: speaker.speakerId,
      speakerLabel: speaker.label || speaker.speakerId,
      voiceId: voice.voiceId,
      voiceName: voice.name,
    }));
    const summary = details.map((item) =>
      item.speakerLabel + "（" + item.voiceName + "，" + item.voiceId + "）",
    ).join("；");
    const message = "以下目标音色需要先完成 ElevenLabs 声音验证：" + summary +
      "。请由声音本人或获授权的声音所有者完成验证，或改选已验证且可用的音色。本次尚未发起 Voice Changer 请求。";
    trace({
      level: "warn",
      event: "voice_verification_blocked",
      stage: "voice_verification",
      jobId: job.id,
      message,
      blockedVoices: details,
    });
    json(res, 409, { error: message, blockedVoices: details });
    return;
  }

  if (!speech.segments.some((segment) => !segment.overlap)) {
    json(res, 409, { error: "所有有效人声片段均存在多人重叠，第一版无法安全地逐人转换" });
    return;
  }

  job.status = "converting";
  job.mixDirty = true; job.outputAvailable = false; job.dialoguePreviewAvailable = false;
  await saveJob(job);
  json(res, 202, { job: publicJob(job) });
  void runConversion(job, apiKey, baseUrl).catch(async (error) => {
    job.status = "failed";
    job.conversionError = error.message;
    job.error = error.message;
    await saveJob(job).catch(() => {});
  });
}

async function updateSpeakerMappings(job, req, res) {
  if (["converting", "scoring"].includes(job.status)) {
    json(res, 409, { error: "变声任务进行中，暂时不能修改人物音色" });
    return;
  }
  const speech = speechData(job);
  if (!speech.speakers.length) {
    json(res, 409, { error: "请先完成视频分析，再配置人物音色" });
    return;
  }
  const body = await readJsonBody(req);
  const mappings = body.mappings && typeof body.mappings === "object" ? body.mappings : {};
  const validation = validateSpeakerMappings(speech.speakers, mappings);
  if (!validation.valid) {
    json(res, 400, { error: validation.errors.join("；"), details: validation.errors });
    return;
  }

  const changedSpeakers = new Set(
    speech.speakers
      .filter((speaker) => (job.voiceMappings?.[speaker.speakerId] ?? "") !== (mappings[speaker.speakerId] ?? ""))
      .map((speaker) => speaker.speakerId),
  );
  job.voiceMappings = Object.fromEntries(
    speech.speakers.map((speaker) => [speaker.speakerId, String(mappings[speaker.speakerId]).trim()]),
  );
  for (const speaker of job.speakers) {
    if (job.voiceMappings[speaker.speakerId]) speaker.voiceId = job.voiceMappings[speaker.speakerId];
  }

  if (changedSpeakers.size > 0) {
    for (const segment of job.segments) {
      if (changedSpeakers.has(segment.speakerId) && segment.status === "completed") {
        segment.status = segment.overlap ? "skipped_overlap" : "pending";
        segment.convertedFile = "";
        segment.outputDuration = 0;
        segment.tempo = 1;
        segment.timingWarning = "";
        segment.error = "";
      }
    }
    job.outputAvailable = false;
    job.dialoguePreviewAvailable = false;
    job.mixDirty = true;
    job.status = "ready";
    job.error = "";
    job.conversionError = "";
    await fs.rm(path.join(jobDirectory(job.id), "output.mp4"), { force: true }).catch(() => {});
  }
  await saveJob(job);
  json(res, 200, { job: publicJob(job) });
}

async function route(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const pathname = url.pathname;

  if (req.method === "POST" && pathname === "/api/diagnostics/client") {
    const rateKey = req.socket.remoteAddress || "local";
    const now = Date.now();
    const previous = clientRates.get(rateKey) ?? { count: 0, resetAt: now + 60_000 };
    const rate = now > previous.resetAt ? { count: 0, resetAt: now + 60_000 } : previous;
    rate.count += 1;
    clientRates.set(rateKey, rate);
    if (rate.count > 120) {
      json(res, 429, { error: "诊断上报过于频繁" });
      return;
    }
    const payload = await readJsonBody(req, 12 * 1024);
    await diagnostics.append(payload, "client");
    json(res, 201, { ok: true });
    return;
  }

  if (req.method === "GET" && (pathname === "/api/diagnostics" || pathname === "/api/diagnostics/export")) {
    const limit = pathname.endsWith("/export") ? 300 : 200;
    const events = await diagnostics.getRecent({ limit });
    if (pathname.endsWith("/export")) {
      res.setHeader("Content-Disposition", 'attachment; filename="scene-recast-debug.json"');
    }
    json(res, 200, {
      generatedAt: new Date().toISOString(),
      application: "scene-recast",
      events,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/status") {
    let mediaTools = null;
    let mediaError = "";
    try {
      mediaTools = await getMediaTools();
    } catch (error) {
      mediaError = error.message;
    }
    json(res, 200, {
      apiKeyRequired: true,
      mediaToolsAvailable: Boolean(mediaTools),
      mediaError,
      diagnosticsEnabled: true,
      temporaryStorage: false,
      persistentStorage: true,
      version: "0.4.0",
      host: "127.0.0.1",
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/voices") {
    const { apiKey, baseUrl } = apiConfig(req);
    if (!apiKey) {
      json(res, 401, { error: "请先在页面填写 ElevenLabs API Key" });
      return;
    }
    const search = String(url.searchParams.get("search") ?? "").slice(0, 120);
    const source = url.searchParams.get("source") === "shared" ? "shared" : "my";
    const result = source === "shared"
      ? await listSharedVoices({
        apiKey,
        baseUrl,
        search,
        language: String(url.searchParams.get("language") ?? "").slice(0, 32),
        accent: String(url.searchParams.get("accent") ?? "").slice(0, 64),
        locale: String(url.searchParams.get("locale") ?? "").slice(0, 16),
        page: url.searchParams.get("page"),
      })
      : await listVoices({
        apiKey,
        baseUrl,
        search,
        pageToken: String(url.searchParams.get("pageToken") ?? "").slice(0, 500),
      });
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/voices/shared/add") {
    const { apiKey, baseUrl } = apiConfig(req);
    if (!apiKey) {
      json(res, 401, { error: "请先在页面填写并验证 ElevenLabs API Key" });
      return;
    }
    const body = await readJsonBody(req);
    const result = await addSharedVoice({
      apiKey,
      baseUrl,
      publicOwnerId: String(body.publicOwnerId ?? "").slice(0, 160),
      voiceId: String(body.voiceId ?? "").slice(0, 120),
      newName: String(body.newName ?? "").trim().slice(0, 100),
    });
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/jobs") {
    await createJob(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/jobs") {
    json(res, 200, { projects: [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((job) => ({ id: job.id, name: job.inputFileName, createdAt: job.createdAt, status: job.status })) });
    return;
  }

  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "api" && parts[1] === "jobs" && parts[2]) {
    const id = parts[2];
    const job = await readJob(id);

    if (req.method === "GET" && parts.length === 3) {
      json(res, 200, { job: publicJob(job) });
      return;
    }

    if (req.method === "POST" && parts[3] === "analyze" && parts.length === 4) {
      if (job.status !== "uploaded") {
        json(res, 409, { error: "该视频已开始分析或已经分析完成" });
        return;
      }
      const { apiKey, baseUrl } = apiConfig(req);
      if (!apiKey) {
        json(res, 401, { error: "请先在页面填写 ElevenLabs API Key" });
        return;
      }
      startAnalysis(job, apiKey, baseUrl);
      json(res, 202, { job: publicJob(job) });
      return;
    }

    if (req.method === "PUT" && parts[3] === "speakers" && parts.length === 4) {
      await updateSpeakerMappings(job, req, res);
      return;
    }

    if (req.method === "GET" && parts[3] === "ducking" && parts.length === 4) {
      const settings = duckingSettings({ ...job.autoDucking, ...JSON.parse(url.searchParams.get("settings") || "{}") }, job.media.duration);
      const timeline = await autoDucking("timeline", path.join(jobDirectory(id), "job.json"), settings);
      json(res, 200, timeline); return;
    }
    if (req.method === "POST" && parts[3] === "music-upload" && parts.length === 4) {
      if (["converting", "analyzing", "scoring"].includes(job.status)) { json(res, 409, { error: "项目正在处理中" }); return; }
      if (!voiceStageReady(job)) { json(res, 409, { error: "步骤顺序：请先完成配音片段，再上传背景音乐" }); return; }
      const dir = jobDirectory(id);
      const previousStatus = job.status;
      job.status = "scoring";
      await saveJob(job);
      const temporary = path.join(dir, "uploaded-music-" + randomUUID());
      try {
        await streamUpload(req, temporary, 100 * 1024 * 1024);
        const duration = await probeDuration(temporary);
        if (!Number.isFinite(duration) || duration < job.media.duration - 0.5) throw Object.assign(new Error("背景音乐时长不足，请使用覆盖整段视频的音轨"), { statusCode: 400 });
        const { ffmpeg } = await getMediaTools();
        await runProcess(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", temporary, "-vn", "-c:a", "libmp3lame", "-b:a", "192k", temporary + ".mp3"]);
        await fs.rename(temporary + ".mp3", path.join(dir, "background-music.mp3"));
        await fs.rm(temporary, { force: true });
        job.mixDirty = true;
        job.musicReady = true; job.musicEnabled = true; job.musicError = "";
        job.status = previousStatus;
        await saveJob(job);
        json(res, 200, { job: publicJob(job) });
      } catch (error) {
        job.status = previousStatus;
        await fs.rm(temporary, { force: true });
        await fs.rm(temporary + ".mp3", { force: true });
        await saveJob(job); throw error;
      }
      return;
    }
    if (req.method === "POST" && parts[3] === "music" && parts.length === 4) {
      if (["converting", "analyzing", "scoring"].includes(job.status)) { json(res, 409, { error: "项目正在处理中" }); return; }
      if (!voiceStageReady(job)) { json(res, 409, { error: "步骤顺序：请先完成配音片段，再生成配乐" }); return; }
      const { apiKey, baseUrl } = apiConfig(req);
      if (!apiKey) { json(res, 401, { error: "请先连接 API Key" }); return; }
      const body = await readJsonBody(req);
      const description = String(body.description || "").trim().slice(0, 3800);
      const previousStatus = job.status;
      const dir = jobDirectory(id);
      job.status = "scoring"; job.musicError = "";
      await saveJob(job);
      try {
        const dialogueVideo = await ensureDialoguePreview(job);
        const music = await generateBackgroundMusic({ videoPath: dialogueVideo, apiKey, baseUrl, description, referenceAudio: body.referenceAudio === true });
        const temporary = path.join(dir, "background-music-new.mp3");
        await fs.writeFile(temporary, music);
        const musicDuration = await probeDuration(temporary);
        if (musicDuration < job.media.duration - 0.5) throw new Error("生成的配乐短于视频，请保留现有配乐并手动重试");
        await fs.rename(temporary, path.join(dir, "background-music.mp3"));
        job.mixDirty = true;
        job.musicReady = true; job.musicEnabled = true; job.musicDescription = description;
        job.musicReferenceAudio = body.referenceAudio === true;
        job.status = previousStatus;
        await saveJob(job);
        json(res, 200, { job: publicJob(job) });
      } catch (error) {
        job.status = previousStatus; job.musicError = error.message;
        await fs.rm(path.join(dir, "background-music-new.mp3"), { force: true });
        await saveJob(job);
        json(res, 502, { error: error.message });
      }
      return;
    }

    if (req.method === "PUT" && parts[3] === "mix" && parts.length === 4) {
      if (["converting", "analyzing", "scoring"].includes(job.status)) {
        json(res, 409, { error: "任务处理期间不能更改混音设置" }); return;
      }
      const body = await readJsonBody(req);
      const previousSettings = JSON.stringify({ speechVolume: job.speechVolume ?? 0, musicEnabled: Boolean(job.musicEnabled), autoDucking: duckingSettings(job.autoDucking, job.media.duration) });
      if (typeof body.speechVolume !== "number" || !Number.isFinite(body.speechVolume) || body.speechVolume < 0 || body.speechVolume > 1) {
        json(res, 400, { error: "原声保留音量必须为 0–100%" }); return;
      }
      if (body.musicEnabled && !job.musicReady) { json(res, 409, { error: "请先生成自动配乐，再启用新音乐" }); return; }
      if (body.musicEnabled !== undefined) job.musicEnabled = Boolean(body.musicEnabled);

      if (body.autoDucking !== undefined) job.autoDucking = duckingSettings(body.autoDucking, job.media.duration);
      job.speechVolume = body.speechVolume;
      if (previousSettings !== JSON.stringify({ speechVolume: job.speechVolume, musicEnabled: Boolean(job.musicEnabled), autoDucking: duckingSettings(job.autoDucking, job.media.duration) })) job.mixDirty = true;
      await saveJob(job);
      json(res, 200, { job: publicJob(job) }); return;
    }
    if (req.method === "POST" && parts[3] === "remix" && parts.length === 4) {
      if (["converting", "analyzing", "scoring"].includes(job.status)) {
        json(res, 409, { error: "项目正在处理中" }); return;
      }
      if (!voiceStageReady(job)) { json(res, 409, { error: "配音片段尚未完成，请先完成配音阶段" }); return; }
      const convertedSegments = completedClips(job);
      if (!convertedSegments.length) { json(res, 409, { error: "请先生成变声片段" }); return; }
      job.status = "converting";
      await saveJob(job);
      try {
        const dir = jobDirectory(id);
        await composeOutputVideo({ videoPath: path.join(dir, "input" + job.inputExtension), sourceAudioPath: path.join(dir, "source-audio.wav"), convertedSegments, duration: job.media.duration, outputPath: path.join(dir, "output-remix.mp4"), videoCodec: job.media.videoCodec, speechVolume: job.speechVolume ?? 0, ...musicMixOptions(job) });
        await fs.rename(path.join(dir, "output-remix.mp4"), path.join(dir, "output.mp4"));
        job.mixDirty = false;
        job.lastMix = { musicEnabled: Boolean(job.musicEnabled && job.musicReady), autoDucking: duckingSettings(job.autoDucking, job.media.duration), renderedAt: new Date().toISOString() };
        job.outputAvailable = true;
        job.status = convertedSegments.length < job.segments.filter(isSpeechSegment).length ? "completed_with_warnings" : "completed";
        await saveJob(job);
        json(res, 200, { job: publicJob(job) });
      } catch (error) {
        job.status = "failed"; job.error = error.message;
        await saveJob(job); throw error;
      }
      return;
    }

    if (req.method === "POST" && parts[3] === "convert" && parts.length === 4) {
      const { apiKey, baseUrl } = apiConfig(req);
      await startConversion(job, res, apiKey, baseUrl);
      return;
    }

    if (req.method === "DELETE" && parts.length === 3) {
      if (["converting", "analyzing", "scoring"].includes(job.status)) {
        json(res, 409, { error: "任务正在处理，暂时不能清理" });
        return;
      }
      await fs.rm(jobDirectory(id), { recursive: true, force: true });
      jobs.delete(id);
      trace({ level: "info", event: "job_cleaned", stage: "cleanup", jobId: id, message: "用户主动清理本次视频任务" });
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && parts[3] === "segment" && parts.length === 6 && parts[5] === "converted") {
      const segment = job.segments.find((segment) => segment.id === parts[4] && segment.status === "completed" && segment.convertedFile);
      if (!segment) { json(res, 404, { error: "配音片段尚未生成" }); return; }
      await sendFileRange(req, res, path.join(jobDirectory(id), "segments", segment.convertedFile), "audio/mpeg"); return;
    }
    if (req.method === "GET" && parts[3] === "file" && parts.length === 5) {
      const kind = parts[4];
      if (kind === "dialogue" && job.dialoguePreviewAvailable) {
        await sendFileRange(req, res, path.join(jobDirectory(id), "dialogue-preview.mp4"), "video/mp4"); return;
      }
      if (kind === "music" && job.musicReady) {
        await sendFileRange(req, res, path.join(jobDirectory(id), "background-music.mp3"), "audio/mpeg"); return;
      }
      if (kind === "original") {
        const filePath = path.join(jobDirectory(id), "input" + job.inputExtension);
        const mimeTypes = {
          ".mp4": "video/mp4",
          ".mov": "video/quicktime",
          ".m4v": "video/x-m4v",
          ".mkv": "video/x-matroska",
          ".webm": "video/webm",
        };
        await sendFileRange(req, res, filePath, mimeTypes[job.inputExtension] || "application/octet-stream");
        return;
      }
      if (kind === "output" && job.outputAvailable && !job.mixDirty) {
        await sendFileRange(req, res, path.join(jobDirectory(id), "output.mp4"), "video/mp4");
        return;
      }
    }
  }

  if (req.method === "GET" && pathname === "/") {
    const html = await fs.readFile(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": html.length });
    res.end(html);
    return;
  }
  if (req.method === "GET" && (pathname === "/assets/app.js" || pathname === "/assets/diagnostics.js")) {
    const name = pathname.endsWith("diagnostics.js") ? "diagnostics.js" : "app.js";
    const body = await fs.readFile(path.join(PUBLIC_DIR, name));
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    res.end(body);
    return;
  }
  if (req.method === "GET" && pathname === "/assets/styles.css") {
    const body = await fs.readFile(path.join(PUBLIC_DIR, "styles.css"));
    res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Content-Length": body.length });
    res.end(body);
    return;
  }

  json(res, 404, { error: "接口或页面不存在" });
}

await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
await fs.mkdir(JOBS_DIR, { recursive: true, mode: 0o700 });
for (const entry of await fs.readdir(JOBS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue;
  try {
    const job = JSON.parse(await fs.readFile(path.join(JOBS_DIR, entry.name, "job.json"), "utf8"));
    if (job.id !== entry.name) continue;
    jobs.set(job.id, job);
    if (["analyzing", "converting", "scoring"].includes(job.status)) {
      job.status = job.speakers?.length ? "ready" : "uploaded";
      job.error = "上次处理被中断，已保留完成片段，可手动重试。";
      await saveJob(job);
    }
  } catch (error) {
    trace({ level: "warn", event: "project_load_failed", message: "无法恢复项目 " + entry.name + "：" + error.message });
  }
}

const port = Math.max(1, Number(process.env.VOICE_DEMO_PORT || 3218));
// Keep the local-only build bound to loopback. Do not expose the API-key entry page to a LAN/public host.
const host = "127.0.0.1";
const server = createServer((req, res) => {
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const routeName = new URL(req.url || "/", "http://127.0.0.1").pathname;
  const jobId = routeName.match(/^\/api\/jobs\/([a-f0-9-]{36})/i)?.[1] || "";
  res.setHeader("X-Debug-Request-Id", requestId);
  res.on("finish", () => {
    if (res.statusCode >= 400 && routeName !== "/api/diagnostics/client") {
      trace({
        level: "warn", event: "http_error", stage: "http",
        requestId, jobId, method: req.method, route: routeName,
        statusCode: res.statusCode, durationMs: Date.now() - startedAt,
        message: "HTTP 请求失败",
      });
    }
  });
  route(req, res).catch((error) => {
    trace({
      level: "error", event: "server_exception", stage: "http",
      requestId, jobId, method: req.method, route: routeName,
      statusCode: error.statusCode || 500, durationMs: Date.now() - startedAt,
      message: error.message || "服务内部错误", stack: error.stack,
    });
    if (!res.headersSent) {
      json(res, error.statusCode || 500, {
        error: error.message || "服务内部错误",
        requestId,
      });
    } else {
      res.destroy(error);
    }
  });
});
server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 30 * 1000;

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  server.closeAllConnections?.();
  await Promise.allSettled([...pendingSaves.values()]);
  process.exit(0);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
server.on("error", (error) => {
  trace({ level: "error", event: "server_start_failed", stage: "startup", message: error.message, stack: error.stack });
  process.stderr.write("SceneRecast 启动失败：" + error.message + "\n");
});
server.listen(port, host, () => {
  trace({ level: "info", event: "server_started", stage: "startup", message: "素材分步版 0.4.0 已启动，端口 " + port });
  process.stdout.write("SceneRecast 已启动：http://" + host + ":" + port + "\n");
});
