import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { getTempoAdjustment } from "./segments.mjs";
import { writeDuckingEnvelope } from "./ducking.mjs";

function binaryCandidates(kind) {
  const configured = kind === "ffmpeg" ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
  const names = kind === "ffmpeg"
    ? ["/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"]
    : ["/opt/homebrew/opt/ffmpeg-full/bin/ffprobe", "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "ffprobe"];
  return [configured, ...names].filter(Boolean);
}

export function runProcess(binary, args, timeoutMs = 300000, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env: options.env || process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(path.basename(binary) + " 执行超时"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 12_000) stderr = stderr.slice(-12_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(path.basename(binary) + " 无法启动：" + error.message));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(path.basename(binary) + " 执行失败（" + code + "）：" + (stderr.trim() || stdout.trim()).slice(-1200)));
    });
  });
}

async function findBinary(candidates, label) {
  for (const candidate of candidates) {
    try {
      await runProcess(candidate, ["-version"], 8000);
      return candidate;
    } catch {
      // Try the next known Homebrew or PATH location.
    }
  }
  throw new Error("未找到 " + label + "。请安装 FFmpeg 并加入 PATH，或设置 FFMPEG_PATH / FFPROBE_PATH 环境变量");
}

let mediaToolsPromise;
export function getMediaTools() {
  if (!mediaToolsPromise) {
    mediaToolsPromise = Promise.all([
      findBinary(binaryCandidates("ffmpeg"), "FFmpeg"),
      findBinary(binaryCandidates("ffprobe"), "FFprobe"),
    ]).then(([ffmpeg, ffprobe]) => ({ ffmpeg, ffprobe })).catch((error) => {
      mediaToolsPromise = null;
      throw error;
    });
  }
  return mediaToolsPromise;
}

export async function probeMedia(filePath) {
  const { ffprobe } = await getMediaTools();
  const { stdout } = await runProcess(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
    "-of", "json",
    filePath,
  ], 30000);
  const parsed = JSON.parse(stdout);
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(parsed.format?.duration ?? 0);
  if (!video) throw new Error("文件中没有可用的视频轨道");
  if (!audio) throw new Error("文件中没有音频轨道，无法执行多人变声");
  if (!(duration > 0)) throw new Error("无法读取视频时长");
  return {
    duration,
    width: Number(video.width ?? 0),
    height: Number(video.height ?? 0),
    frameRate: String(video.r_frame_rate ?? ""),
    videoCodec: String(video.codec_name ?? ""),
    audioCodec: String(audio.codec_name ?? ""),
    sampleRate: Number(audio.sample_rate ?? 0),
    channels: Number(audio.channels ?? 0),
  };
}

export async function extractAudioTracks(videoPath, sourceAudioPath, sttAudioPath) {
  const { ffmpeg } = await getMediaTools();
  await runProcess(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", videoPath,
    "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le",
    sourceAudioPath,
  ], 180000);
  await runProcess(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", videoPath,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    sttAudioPath,
  ], 180000);
}

export async function extractSegment(sourceAudioPath, startSeconds, durationSeconds, outputPath) {
  const { ffmpeg } = await getMediaTools();
  await runProcess(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", String(Math.max(0, startSeconds)),
    "-i", sourceAudioPath,
    "-t", String(Math.max(0.1, durationSeconds)),
    "-vn", "-ac", "2", "-ar", "44100",
    "-c:a", "libmp3lame", "-b:a", "192k",
    outputPath,
  ], 60000);
}

export async function probeDuration(filePath) {
  const { ffprobe } = await getMediaTools();
  const { stdout } = await runProcess(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], 30000);
  return Number(stdout.trim());
}

export async function composeOutputVideo({ videoPath, sourceAudioPath, convertedSegments, duration, outputPath, videoCodec, speechVolume = 0, musicPath = "", dialogueOnly = false, speechSegments = convertedSegments, speechWords = [], autoDuckingSettings = {} }) {
  if (!convertedSegments.length) throw new Error("没有成功的变声音频片段，无法合成视频");
  const { ffmpeg } = await getMediaTools();
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", videoPath, "-i", sourceAudioPath];
  for (const segment of convertedSegments) args.push("-i", segment.filePath);
  const envelopePath = path.join(path.dirname(outputPath), "ducking-envelope.wav");
  const completedIds = new Set(convertedSegments.map((segment) => segment.id));
  const retainedSpeech = speechSegments.filter((segment) => !completedIds.has(segment.id));
  const replaceBackground = Boolean(musicPath) || dialogueOnly;
  await writeDuckingEnvelope(envelopePath, duration, replaceBackground ? retainedSpeech : convertedSegments, replaceBackground ? 0 : speechVolume, { invert: replaceBackground });
  args.push("-i", envelopePath);
  const envelopeIndex = convertedSegments.length + 2;
  const filters = [
    "[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[source]",
    "[" + envelopeIndex + ":a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[envelope]",
    "[source][envelope]amultiply[base]",
  ];
  let previousMix = "base";

  convertedSegments.forEach((segment, index) => {
    const inputIndex = index + 2;
    const targetDuration = Math.max(0.1, segment.end - segment.start);
    const adjustment = getTempoAdjustment(segment.outputDuration, targetDuration);
    const tempo = adjustment.tempo.toFixed(4);
    const delay = Math.max(0, Math.round(segment.start * 1000));
    const label = "voice" + index;
    const mixLabel = "mix" + index;
    filters.push(
      "[" + inputIndex + ":a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo" +
      ",atempo=" + tempo +
      ",apad,atrim=duration=" + targetDuration.toFixed(3) +
      ",adelay=" + delay + "|" + delay + "[" + label + "]"
    );
    filters.push("[" + previousMix + "][" + label + "]amix=inputs=2:duration=first:normalize=0[" + mixLabel + "]");
    previousMix = mixLabel;
  });

  filters.push("[" + previousMix + "]alimiter=limit=0.95[outa]");
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "0:v:0",
    "-map", "[outa]",
    "-c:v", videoCodec === "h264" ? "copy" : "libx264",
  );
  if (videoCodec !== "h264") args.push("-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p");
  args.push(
    "-c:a", "aac",
    "-b:a", "192k",
    "-t", String(duration),
    "-movflags", "+faststart",
    musicPath ? path.join(path.dirname(outputPath), "voice-only.mp4") : outputPath,
  );
  await runProcess(ffmpeg, args, 600000);
  if (musicPath) {
    const { autoDucking, duckingSettings } = await import("./auto-ducking.mjs");
    const dir = path.dirname(outputPath);
    const normalized = path.join(dir, "background-music-normalized.wav");
    await runProcess(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", musicPath, "-vn", "-af", "loudnorm=I=-18:TP=-2:LRA=11", "-ar", "48000", "-ac", "2", normalized]);
    const metadata = path.join(dir, "auto-ducking-input.json");
    await writeFile(metadata, JSON.stringify({ duration, segments: speechSegments, speechWords }));
    const result = await autoDucking("render", metadata, duckingSettings(autoDuckingSettings, duration), [path.join(dir, "voice-only.mp4"), normalized, outputPath]);
    await writeFile(path.join(dir, "auto-ducking-report.json"), JSON.stringify(result, null, 2));
  }
  return probeMedia(outputPath);
}
