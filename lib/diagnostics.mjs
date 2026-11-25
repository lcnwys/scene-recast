import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const FIELD_LIMIT = 1500;
const allowedLevels = new Set(["debug", "info", "warn", "error"]);

export function redact(value, maxLength = FIELD_LIMIT) {
  const text = String(value ?? "");
  return text
    .replace(/\b(?:xi-api-key|authorization|api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*(?:Bearer\s+)?["']?([^\s"'&,;}]*)/gi, (whole) => {
      const separator = whole.indexOf(":") >= 0 ? ":" : "=";
      return whole.split(/[:=]/, 1)[0] + separator + "[REDACTED]";
    })
    .replace(/\bBearer\s+[a-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk_[a-z0-9_-]{12,}\b/gi, "[REDACTED_KEY]")
    .replace(/\bxi-[a-z0-9_-]{20,}\b/gi, "[REDACTED_KEY]")
    .slice(0, maxLength);
}

function safeText(value, limit = FIELD_LIMIT) {
  return value === undefined || value === null ? undefined : redact(value, limit);
}

export function normalizeEvent(input = {}, source = "server") {
  const event = input && typeof input === "object" ? input : {};
  const result = {
    timestamp: new Date().toISOString(),
    source: source === "client" ? "client" : "server",
    level: allowedLevels.has(event.level) ? event.level : "info",
    event: safeText(event.event, 100) || "unknown",
    stage: safeText(event.stage, 100) || "",
    jobId: safeText(event.jobId, 72) || "",
    requestId: safeText(event.requestId, 72) || "",
    message: safeText(event.message, 650) || "",
  };
  for (const key of ["method", "route", "statusCode", "durationMs", "segmentId", "speakerId"]) {
    if (event[key] === undefined || event[key] === null) continue;
    if (["statusCode", "durationMs"].includes(key)) {
      const value = Number(event[key]);
      if (Number.isFinite(value)) result[key] = Math.round(value);
    } else {
      result[key] = safeText(event[key], key === "route" ? 160 : 80);
    }
  }
  if (event.stack) result.stack = safeText(event.stack, 1800);
  return result;
}

export function createDiagnostics(logFilePath = "") {
  let pending = Promise.resolve();
  let inMemory = [];

  async function append(event, source = "server") {
    const entry = normalizeEvent(event, source);
    inMemory.push(entry);
    if (inMemory.length > 400) inMemory = inMemory.slice(-400);
    if (!logFilePath) return entry;

    pending = pending.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(logFilePath), { recursive: true });
      try {
        const info = await fs.stat(logFilePath);
        if (info.size > MAX_LOG_BYTES) {
          await fs.rename(logFilePath, logFilePath + ".previous").catch(async () => {
            await fs.rm(logFilePath, { force: true });
          });
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await fs.appendFile(logFilePath, JSON.stringify(entry) + "\n", "utf8");
    });

    await pending;
    return entry;
  }

  async function getRecent({ limit = 100, jobId = "", level = "" } = {}) {
    await pending.catch(() => {});
    let events;
    if (!logFilePath) {
      events = [...inMemory];
    } else {
      try {
        const raw = await fs.readFile(logFilePath, "utf8");
        events = raw.split("\n").filter(Boolean).map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        events = [...inMemory];
      }
    }

    const filtered = events.filter((entry) =>
      (!jobId || entry.jobId === jobId) &&
      (!level || entry.level === level)
    );
    return filtered.slice(-Math.min(300, Math.max(1, Number(limit) || 100)));
  }

  return {
    filePath: logFilePath,
    append,
    getRecent,
  };
}
