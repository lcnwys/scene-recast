import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSpeakerSegments,
  getTempoAdjustment,
  validateSpeakerMappings,
} from "../lib/segments.mjs";

test("merges adjacent words from the same speaker into utterances", () => {
  const result = buildSpeakerSegments([
    { text: "你好", start: 0.2, end: 0.7, speaker_id: "speaker_0", type: "word" },
    { text: "，", start: 0.7, end: 0.8, speaker_id: "speaker_0", type: "word" },
    { text: "最近", start: 1.0, end: 1.4, speaker_id: "speaker_0", type: "word" },
    { text: "怎么样", start: 1.45, end: 1.9, speaker_id: "speaker_0", type: "word" },
  ], 10);

  assert.equal(result.speakers.length, 1);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].text, "你好，最近怎么样");
  assert.equal(result.segments[0].speakerId, "speaker_0");
});

test("keeps different speakers separate and flags real overlap", () => {
  const result = buildSpeakerSegments([
    { text: "我觉得", start: 1.0, end: 2.0, speaker_id: "speaker_0", type: "word" },
    { text: "不是", start: 1.6, end: 2.4, speaker_id: "speaker_1", type: "word" },
  ], 5);

  assert.equal(result.speakers.length, 2);
  assert.equal(result.segments.length, 2);
  assert.ok(result.segments.every((segment) => segment.overlap));
  assert.ok(result.segments.every((segment) => segment.status === "skipped_overlap"));
});

test("does not flag neighboring turns whose speech does not overlap", () => {
  const result = buildSpeakerSegments([
    { text: "第一句", start: 1.0, end: 1.8, speaker_id: "speaker_0", type: "word" },
    { text: "第二句", start: 1.82, end: 2.5, speaker_id: "speaker_1", type: "word" },
  ], 5);

  assert.equal(result.segments.length, 2);
  assert.ok(result.segments.every((segment) => !segment.overlap));
});

test("counts words without a speaker id instead of silently assigning them", () => {
  const result = buildSpeakerSegments([
    { text: "嗯", start: 0.1, end: 0.3, speaker_id: null, type: "word" },
    { text: "你好", start: 0.4, end: 0.8, speaker_id: "speaker_0", type: "word" },
  ], 5);

  assert.equal(result.unassignedWordCount, 1);
  assert.equal(result.speakers.length, 1);
});

test("requires every speaker to have a distinct target voice", () => {
  const speakers = [{ speakerId: "speaker_0" }, { speakerId: "speaker_1" }];
  assert.equal(validateSpeakerMappings(speakers, {
    speaker_0: "voice-a",
    speaker_1: "voice-b",
  }).valid, true);
  assert.equal(validateSpeakerMappings(speakers, {
    speaker_0: "voice-a",
    speaker_1: "voice-a",
  }).valid, false);
  assert.equal(validateSpeakerMappings(speakers, {
    speaker_0: "voice-a",
  }).valid, false);
});

test("ignores Scribe audio events instead of treating music and sound effects as speakers", () => {
  const result = buildSpeakerSegments([
    { text: "[背景音乐]", start: 0.0, end: 0.5, speaker_id: "speaker_music", type: "audio_event" },
    { text: "你好", start: 0.6, end: 1.0, speaker_id: "speaker_0", type: "word" },
    { text: "[脚步声]", start: 1.1, end: 1.4, speaker_id: "speaker_fx", type: "audio_event" },
  ], 5);

  assert.deepEqual(result.speakers.map((speaker) => speaker.speakerId), ["speaker_0"]);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].text, "你好");
});

test("accepts seven distinct Voice IDs", () => {
  const speakers = Array.from({ length: 7 }, (_, index) => ({
    speakerId: "speaker_" + index,
    label: "人物 " + String(index + 1).padStart(2, "0"),
  }));
  const mappings = {
    speaker_0: "voice-test-1",
    speaker_1: "voice-test-2",
    speaker_2: "voice-test-3",
    speaker_3: "voice-test-4",
    speaker_4: "voice-test-5",
    speaker_5: "voice-test-6",
    speaker_6: "voice-test-7",
  };

  const result = validateSpeakerMappings(speakers, mappings);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);

  const duplicate = validateSpeakerMappings(speakers, {
    ...mappings,
    speaker_6: mappings.speaker_5,
  });
  assert.equal(duplicate.valid, false);
  assert.match(duplicate.errors[0], /人物 06 和 人物 07 的 Voice ID 相同/);
  assert.match(duplicate.errors[0], /voice-test-6/);
});

test("limits extreme timing correction and warns about large duration drift", () => {
  assert.equal(getTempoAdjustment(4.2, 4).tempo, 1.05);
  const adjusted = getTempoAdjustment(8, 4);
  assert.equal(adjusted.tempo, 1.33);
  assert.ok(adjusted.warning);
});
