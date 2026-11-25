import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMediaTools, runProcess } from "./media.mjs";

export const DUCKING_DEFAULTS = { gap: 1, normal_music_db: -6, reduction_db: 8, attack: 0.15, release: 0.55, pre: 0.15, post: 0.25, manual_segments: null };

export function duckingSettings(input = {}, duration = 600) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("Auto Ducking 设置应为参数对象"), { statusCode: 400 });
  const settings = { ...DUCKING_DEFAULTS };
  const bounds = { gap: [0, 5], normal_music_db: [-30, 0], reduction_db: [0, 36], attack: [0.05, 2], release: [0.1, 3], pre: [0, 1], post: [0, 2] };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw Object.assign(new Error("Auto Ducking 参数无效：" + key), { statusCode: 400 });
    settings[key] = value;
  }
  if (input.manual_segments != null) {
    if (!Array.isArray(input.manual_segments) || input.manual_segments.length > 1000 || input.manual_segments.some((s) => !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end <= s.start || s.end > duration)) throw Object.assign(new Error("手动区间必须在视频时长内，且起点小于终点"), { statusCode: 400 });
    settings.manual_segments = input.manual_segments.map(({ start, end }) => ({ start, end }));
  }
  return settings;
}

export async function autoDucking(operation, metadataPath, settings, extra = []) {
  const tools = await getMediaTools();
  const binaryDirs = [tools.ffmpeg, tools.ffprobe].filter(path.isAbsolute).map((binary) => path.dirname(binary));
  const script = fileURLToPath(new URL("../vendor/auto-ducking/bridge.py", import.meta.url));
  const { stdout } = await runProcess(process.env.PYTHON_PATH || "python3", [script, operation, metadataPath, JSON.stringify(duckingSettings(settings)), ...extra], 600000, { env: { ...process.env, PATH: [...binaryDirs, process.env.PATH || ""].join(path.delimiter), PYTHONDONTWRITEBYTECODE: "1" } });
  return JSON.parse(stdout);
}
