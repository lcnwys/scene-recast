import { readFile, stat } from "node:fs/promises";

export async function generateBackgroundMusic({ videoPath, apiKey, baseUrl, description = "", referenceAudio = false }) {
  if (!apiKey) throw new Error("请先连接 ElevenLabs API Key");
  if ((await stat(videoPath)).size > 200 * 1024 * 1024) throw new Error("自动配乐的视频上传不能超过 200 MB");
  const form = new FormData();
  form.append("videos", new Blob([await readFile(videoPath)]), "source-video" + videoPath.slice(videoPath.lastIndexOf(".")));
  form.append("model_id", "music_v2_5");
  form.append("add_sfx", "false");
  form.append("separate_tracks", "false");
  form.append("use_audio_as_reference", String(referenceAudio));
  form.append("description", "Instrumental background score only. No vocals, lyrics, speech or choir. Smooth continuous texture throughout the video, suitable beneath dialogue. " + description.slice(0, 3800));
  const response = await fetch(baseUrl + "/v1/music/video-to-music", {
    method: "POST", headers: { "xi-api-key": apiKey }, body: form, signal: AbortSignal.timeout(360000),
  });
  if (!response.ok) {
    // Do not persist arbitrary upstream response text, which may echo submitted content.
    await response.body?.cancel();
    throw new Error("ElevenLabs 自动配乐失败（HTTP " + response.status + "），请检查 Music 权限、额度和视频规格");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 100 * 1024 * 1024 || bytes.subarray(0, 2).toString() === "PK" || /json|zip/.test(response.headers.get("content-type") || "")) {
    throw new Error("自动配乐未返回预期的单条音频文件");
  }
  return bytes;
}
