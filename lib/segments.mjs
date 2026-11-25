const DEFAULTS = {
  mergeGapSeconds: 0.72,
  paddingSeconds: 0.12,
  overlapThresholdSeconds: 0.12,
  shortSpeechSeconds: 0.45,
};

function finiteTime(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function buildSpeakerSegments(words, durationSeconds, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const validWords = (Array.isArray(words) ? words : [])
    // Scribe audio_event items describe music, footsteps, breathing, etc.; they are not speakers.
    .filter((word) => word?.type !== "audio_event")
    .filter((word) => finiteTime(word?.start) && finiteTime(word?.end) && word.end >= word.start)
    .map((word) => ({
      start: word.start,
      end: word.end,
      text: String(word.text ?? ""),
      type: word.type ?? "word",
      speakerId: typeof word.speaker_id === "string" && word.speaker_id.trim()
        ? word.speaker_id.trim()
        : null,
    }));

  const unassignedWordCount = validWords.filter((word) => !word.speakerId).length;
  const bySpeaker = new Map();

  for (const word of validWords) {
    if (!word.speakerId) continue;
    const list = bySpeaker.get(word.speakerId) ?? [];
    list.push(word);
    bySpeaker.set(word.speakerId, list);
  }

  const segments = [];
  for (const [speakerId, speakerWords] of bySpeaker) {
    speakerWords.sort((a, b) => a.start - b.start || a.end - b.end);
    let current = null;

    const flush = () => {
      if (!current) return;
      const speechStart = current.words[0].start;
      const speechEnd = Math.max(...current.words.map((word) => word.end));
      const clipStart = Math.max(0, speechStart - config.paddingSeconds);
      const clipEnd = Math.min(
        Number.isFinite(durationSeconds) ? durationSeconds : speechEnd + config.paddingSeconds,
        speechEnd + config.paddingSeconds,
      );
      const text = current.words.map((word) => word.text).join("").trim();

      segments.push({
        speakerId,
        speechStart,
        speechEnd,
        start: clipStart,
        end: Math.max(clipStart, clipEnd),
        text,
        wordCount: current.words.filter((word) => word.type === "word" || !["spacing", "audio_event"].includes(word.type)).length,
        hasAudioEvent: current.words.some((word) => word.type === "audio_event"),
        overlap: false,
        overlapSeconds: 0,
        short: speechEnd - speechStart < config.shortSpeechSeconds,
        status: "pending",
      });
      current = null;
    };

    for (const word of speakerWords) {
      if (!current) {
        current = { words: [word] };
        continue;
      }

      const previousEnd = Math.max(...current.words.map((item) => item.end));
      const gap = word.start - previousEnd;
      if (gap <= config.mergeGapSeconds) {
        current.words.push(word);
      } else {
        flush();
        current = { words: [word] };
      }
    }
    flush();
  }

  segments.sort((a, b) => a.speechStart - b.speechStart || a.speechEnd - b.speechEnd);
  for (let index = 0; index < segments.length; index += 1) {
    segments[index].id = `seg-${String(index + 1).padStart(4, "0")}`;
  }

  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    const left = segments[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
      const right = segments[rightIndex];
      if (right.speechStart >= left.speechEnd) break;
      if (left.speakerId === right.speakerId) continue;
      const overlapSeconds = Math.min(left.speechEnd, right.speechEnd) - Math.max(left.speechStart, right.speechStart);
      if (overlapSeconds > config.overlapThresholdSeconds) {
        left.overlap = true;
        right.overlap = true;
        left.overlapSeconds = Math.max(left.overlapSeconds, overlapSeconds);
        right.overlapSeconds = Math.max(right.overlapSeconds, overlapSeconds);
        left.status = "skipped_overlap";
        right.status = "skipped_overlap";
      }
    }
  }

  const speakers = [...bySpeaker.keys()]
    .map((speakerId) => {
      const ownSegments = segments.filter((segment) => segment.speakerId === speakerId);
      const sample = ownSegments.find((segment) => !segment.overlap && !segment.short) ?? ownSegments[0] ?? null;
      return {
        speakerId,
        segmentCount: ownSegments.length,
        wordCount: ownSegments.reduce((sum, segment) => sum + segment.wordCount, 0),
        firstSeen: ownSegments[0]?.speechStart ?? 0,
        sampleSegmentId: sample?.id ?? null,
        sampleText: sample?.text ?? "",
        voiceId: "",
      };
    })
    .sort((a, b) => a.firstSeen - b.firstSeen);

  return { speakers, segments, unassignedWordCount };
}

export function validateSpeakerMappings(speakers, mappings) {
  const errors = [];
  const entries = speakers.map((speaker) => ({
    speakerId: speaker.speakerId,
    label: speaker.label || speaker.speakerId,
    voiceId: String(mappings?.[speaker.speakerId] ?? "").trim(),
  }));

  for (const entry of entries) {
    if (!entry.voiceId) errors.push(`${entry.label} 尚未选择目标音色`);
  }

  const owners = new Map();
  for (const entry of entries) {
    if (!entry.voiceId) continue;
    const previous = owners.get(entry.voiceId);
    if (previous) {
      errors.push(`${previous.label} 和 ${entry.label} 的 Voice ID 相同（${entry.voiceId}），请分别选择不同音色`);
    } else {
      owners.set(entry.voiceId, entry);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function getTempoAdjustment(sourceDuration, targetDuration) {
  if (!(sourceDuration > 0) || !(targetDuration > 0)) {
    return { tempo: 1, warning: "无法测量音频时长，使用原速并通过补齐/裁剪对齐" };
  }
  const requestedTempo = sourceDuration / targetDuration;
  const tempo = Math.min(1.33, Math.max(0.75, requestedTempo));
  const ratio = Math.abs(requestedTempo - 1);
  return {
    tempo,
    warning: ratio > 0.18
      ? "生成音频与原时间段时长差异较大，已限制变速范围；最终片段可能出现轻微裁剪或静音补齐"
      : "",
  };
}
