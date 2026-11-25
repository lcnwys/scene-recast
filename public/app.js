const state = { file: null, job: null, voices: [], draftMappings: {}, pollTimer: null, apiKey: "", voicePage: 0, voicePageToken: "", voiceHasMore: false, sharedVoiceCopies: {}, activeSegmentId: "" };

function rememberJob(id) {
  const url = new URL(window.location.href);
  url.searchParams.set("job", id);
  window.history.replaceState(null, "", url.pathname + url.search);
}

const $ = (id) => document.getElementById(id);

const ui = {
  apiStatus: $("apiStatus"),
  mediaStatus: $("mediaStatus"),
  apiKeyInput: $("apiKeyInput"),
  connectApiKeyButton: $("connectApiKeyButton"),
  clearApiKeyButton: $("clearApiKeyButton"),
  apiKeyHint: $("apiKeyHint"),
  cleanupButton: $("cleanupButton"),
  uploadPanel: $("uploadPanel"),
  changeVideoButton: $("changeVideoButton"),
  fileInput: $("fileInput"),
  dropzone: $("dropzone"),
  selectedFile: $("selectedFile"),
  selectedName: $("selectedName"),
  selectedMeta: $("selectedMeta"),
  uploadButton: $("uploadButton"),
  uploadHint: $("uploadHint"),
  clearFileButton: $("clearFileButton"),
  uploadProgressWrap: $("uploadProgressWrap"),
  uploadProgressText: $("uploadProgressText"),
  uploadProgressValue: $("uploadProgressValue"),
  uploadProgressBar: $("uploadProgressBar"),
  jobSummary: $("jobSummary"),
  transcriptEmpty: $("transcriptEmpty"),
  sourcePreviewVideo: $("sourcePreviewVideo"),
  analyzeButton: $("analyzeButton"),
  analysisPanel: $("analysisPanel"),
  analysisProgress: $("analysisProgress"),
  analysisProgressText: $("analysisProgressText"),
  analysisProgressValue: $("analysisProgressValue"),
  analysisProgressBar: $("analysisProgressBar"),
  analysisAlerts: $("analysisAlerts"),
  speakerSummary: $("speakerSummary"),
  segmentCount: $("segmentCount"),
  segmentList: $("segmentList"),
  mappingPanel: $("mappingPanel"),
  voiceSearch: $("voiceSearch"),
  voiceSource: $("voiceSource"),
  voiceLanguage: $("voiceLanguage"),
  voiceAccent: $("voiceAccent"),
  voiceLocale: $("voiceLocale"),
  activeSegmentTime: $("activeSegmentTime"),
  languageFilterWrap: $("languageFilterWrap"),
  accentFilterWrap: $("accentFilterWrap"),
  localeFilterWrap: $("localeFilterWrap"),
  reloadVoicesButton: $("reloadVoicesButton"),
  loadMoreVoicesButton: $("loadMoreVoicesButton"),
  voiceHint: $("voiceHint"),
  speakerMappingList: $("speakerMappingList"),
  saveMappingButton: $("saveMappingButton"),
  mappingErrors: $("mappingErrors"),
  conversionPanel: $("conversionPanel"),
  voiceAssets: $("voiceAssets"), voiceClips: $("voiceClips"), dialoguePreview: $("dialoguePreview"), continueMusicButton: $("continueMusicButton"),
  musicPanel: $("musicPanel"), finalMixPanel: $("finalMixPanel"), musicStageStatus: $("musicStageStatus"), finalAssetSummary: $("finalAssetSummary"), musicSpeechLevel: $("musicSpeechLevel"), resetDuckingButton: $("resetDuckingButton"),
  conversionSummary: $("conversionSummary"),
  conversionProgress: $("conversionProgress"),
  conversionProgressText: $("conversionProgressText"),
  conversionProgressValue: $("conversionProgressValue"),
  conversionProgressBar: $("conversionProgressBar"),
  conversionCounts: $("conversionCounts"),
  conversionAlerts: $("conversionAlerts"),
  convertButton: $("convertButton"),
  comparePanel: $("comparePanel"),
  originalVideo: $("originalVideo"),
  changedVideo: $("changedVideo"),
  savedProjects: $("savedProjects"),
  speechVolume: $("speechVolume"),
  speechVolumeValue: $("speechVolumeValue"),
  remixButton: $("remixButton"),
  musicEnabled: $("musicEnabled"),
  musicDescription: $("musicDescription"),
  generateMusicButton: $("generateMusicButton"),
  musicStatus: $("musicStatus"),
  musicPreview: $("musicPreview"),
  musicFile: $("musicFile"), musicUploadButton: $("musicUploadButton"), referenceAudio: $("referenceAudio"),
  musicLevel: $("musicLevel"), musicLevelValue: $("musicLevelValue"),
  musicReduction: $("musicReduction"), musicReductionValue: $("musicReductionValue"),
  duckGap: $("duckGap"), duckGapValue: $("duckGapValue"),
  duckAttack: $("duckAttack"), duckAttackValue: $("duckAttackValue"),
  duckRelease: $("duckRelease"), duckReleaseValue: $("duckReleaseValue"),
  manualDuck: $("manualDuck"), rawLane: $("rawLane"), mergedLane: $("mergedLane"),
  duckEndTime: $("duckEndTime"), duckTimelineStatus: $("duckTimelineStatus"), mixAppliedStatus: $("mixAppliedStatus"),
  downloadButton: $("downloadButton"),
  toast: $("toast"),
};


function showToast(message) {
  const toast = $("toast");
  toast.textContent = String(message);
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const wholeSeconds = Math.floor(value % 60);
  return String(minutes).padStart(2, "0") + ":" + String(wholeSeconds).padStart(2, "0");
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return (value / 1024).toFixed(0) + " KB";
  return (value / 1024 / 1024).toFixed(1) + " MB";
}

async function request(path, options = {}) {
  const startedAt = performance.now();
  const method = options.method || "GET";
  try {
    const response = await fetch(path, options);
    const payload = (response.headers.get("content-type") || "").includes("application/json")
      ? await response.json()
      : null;
    if (!response.ok) {
      const error = new Error(payload?.error || "请求失败（" + response.status + "）");
      error.statusCode = response.status;
      error.requestId = response.headers.get("X-Debug-Request-Id") || "";
      throw error;
    }
    if (method !== "GET" || path === "/api/voices") {
      window.demoDiagnostics?.record({
        level: "info", event: "api_success", stage: "http",
        route: path, message: method + " 请求完成 (" + Math.round(performance.now() - startedAt) + "ms)",
        requestId: response.headers.get("X-Debug-Request-Id") || "",
      });
    }
    return payload;
  } catch (error) {
    window.demoDiagnostics?.record({
      level: "error", event: "api_failed", stage: "http",
      route: path, statusCode: error.statusCode, requestId: error.requestId,
      message: method + " 请求失败：" + error.message,
      stack: error.stack,
    });
    throw error;
  }
}
function apiKeyHeaders() {
  if (!state.apiKey) throw new Error("请先填写并验证 ElevenLabs API Key");
  return { "X-ElevenLabs-Api-Key": state.apiKey };
}

async function connectApiKey() {
  const candidate = ui.apiKeyInput.value.trim();
  if (!candidate) {
    showToast("请先填写 ElevenLabs API Key");
    ui.apiKeyInput.focus();
    return;
  }

  ui.connectApiKeyButton.disabled = true;
  ui.apiKeyHint.textContent = "正在验证 API Key 并读取账户音色…";
  try {
    const result = await request("/api/voices", {
      headers: { "X-ElevenLabs-Api-Key": candidate },
    });
    state.apiKey = candidate;
    state.voices = result.voices || [];
    ui.apiKeyInput.value = "";
    setStatus(ui.apiStatus, "ElevenLabs API 已连接", "good");
    ui.apiKeyHint.textContent =
      "Key 验证成功，已读取 " + state.voices.length +
      " 个音色。Key 只保存在当前页面内存，刷新或关闭页面后自动清除。";
    ui.uploadButton.disabled = !state.file;
    if (state.job?.speakers?.length) renderSpeakerMappings();
    showToast("ElevenLabs API Key 验证成功");
  } catch (error) {
    state.apiKey = "";
    state.voices = [];
    setStatus(ui.apiStatus, "API Key 验证失败", "bad");
    ui.apiKeyHint.textContent = error.message;
  } finally {
    ui.connectApiKeyButton.disabled = false;
  }
}

function clearApiKey() {
  state.apiKey = "";
  state.voices = [];
  ui.apiKeyInput.value = "";
  ui.uploadButton.disabled = true;
  setStatus(ui.apiStatus, "等待填写 API Key", "bad");
  ui.apiKeyHint.textContent = "API Key 已从当前页面内存清除。";
  if (state.job?.speakers?.length) {
    ui.voiceHint.textContent = "请重新连接 API Key 后加载账户音色。";
    renderSpeakerMappings();
  }
}

function setStep(step) {
  document.querySelectorAll(".step").forEach((element) => {
    const number = Number(element.dataset.step);
    element.classList.toggle("active", number === step);
    element.classList.toggle("done", number < step);
  });
}

function setStatus(element, label, status) {
  element.classList.remove("good", "bad");
  if (status === "good") element.classList.add("good");
  if (status === "bad") element.classList.add("bad");
  element.innerHTML = "<i></i>" + escapeHtml(label);
}

async function checkStatus() {
  try {
    const result = await request("/api/status");
    setStatus(ui.apiStatus, "等待填写 API Key", "bad");
    setStatus(ui.mediaStatus, result.mediaToolsAvailable ? "FFmpeg 已就绪" : "FFmpeg 未就绪", result.mediaToolsAvailable ? "good" : "bad");
    if (!result.mediaToolsAvailable) {
      ui.uploadHint.textContent = result.mediaError;
    } else {
      ui.uploadHint.textContent = "先连接你自己的 ElevenLabs API Key，再上传视频。";
    }
  } catch (error) {
    setStatus(ui.apiStatus, "服务连接失败", "bad");
    setStatus(ui.mediaStatus, "媒体环境未知", "bad");
    showToast(error.message);
  }
}

function chooseFile(file) {
  if (!file) return;
  if (!/\.(mp4|mov|m4v|mkv|webm)$/i.test(file.name)) {
    showToast("请选择 MP4、MOV、M4V、MKV 或 WebM 视频");
    return;
  }
  state.file = file;
  ui.dropzone.hidden = true;
  ui.selectedFile.hidden = false;
  ui.selectedName.textContent = file.name;
  ui.selectedMeta.textContent = formatBytes(file.size) + " · " + (file.type || "video");
  ui.uploadButton.disabled = !state.apiKey;
}

function clearFile() {
  state.file = null;
  ui.fileInput.value = "";
  ui.dropzone.hidden = false;
  ui.selectedFile.hidden = true;
  ui.uploadProgressWrap.hidden = true;
  ui.uploadProgressText.textContent = "正在上传";
  ui.uploadProgressValue.textContent = "0%";
  ui.uploadProgressBar.style.width = "0%";
  ui.uploadButton.disabled = true;
}

function uploadRequest(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/jobs");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.round(event.loaded / event.total * 100);
      ui.uploadProgressValue.textContent = percent + "%";
      ui.uploadProgressBar.style.width = percent + "%";
    });
    xhr.addEventListener("load", () => {
      let payload = {};
      try { payload = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) {
        window.demoDiagnostics?.record({ level: "info", event: "upload_complete", stage: "upload", message: "视频上传完成", requestId: xhr.getResponseHeader("X-Debug-Request-Id") });
        resolve(payload);
      } else {
        const message = payload.error || "上传失败（" + xhr.status + "）";
        window.demoDiagnostics?.record({ level: "error", event: "upload_failed", stage: "upload", route: "/api/jobs", statusCode: xhr.status, requestId: xhr.getResponseHeader("X-Debug-Request-Id"), message });
        reject(new Error(message));
      }
    });
    xhr.addEventListener("error", () => {
      window.demoDiagnostics?.record({ level: "error", event: "upload_network_failed", stage: "upload", message: "浏览器上传连接失败" });
      reject(new Error("上传连接失败"));
    });
    xhr.send(file);
  });
}

function renderJobSummary() {
  const job = state.job;
  if (!job) return;
  const media = job.media || {};
  const items = [
    ["视频时长", formatTime(media.duration)],
    ["分辨率", (media.width || 0) + " × " + (media.height || 0)],
    ["帧率", media.frameRate || "—"],
    ["文件", job.inputFileName || "—"],
  ];
  ui.jobSummary.innerHTML = items.map(([label, value]) =>
    '<div class="summary-item"><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(value) + '</b></div>'
  ).join("");
}

async function uploadFile() {
  if (!state.file) return;
  ui.uploadButton.disabled = true;
  ui.uploadProgressWrap.hidden = false;
  ui.uploadProgressText.textContent = "正在上传视频到本机";
  ui.uploadProgressValue.textContent = "0%";
  ui.uploadProgressBar.style.width = "0%";
  try {
    const response = await uploadRequest(state.file);
    state.job = response.job;
    state.draftMappings = {};
    ui.cleanupButton.disabled = false;
    window.demoDiagnostics?.setJobId(state.job.id);
    rememberJob(state.job.id);
    ui.sourcePreviewVideo.src = state.job.originalUrl;
    ui.sourcePreviewVideo.load();
    ui.uploadProgressValue.textContent = "100%";
    ui.uploadProgressBar.style.width = "100%";
    renderJobSummary();
    ui.uploadPanel.hidden = true;
    ui.analysisPanel.hidden = false;
    ui.transcriptEmpty.hidden = false;
    ui.analyzeButton.disabled = false;
    setStep(1);
    void loadProjects();
    showToast("视频上传完成，已保存项目");
    ui.analysisPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    ui.uploadButton.disabled = false;
    ui.uploadProgressWrap.hidden = true;
    showToast(error.message);
  }
}

function renderAlert(container, message, isError = false) {
  const element = document.createElement("div");
  element.className = "alert" + (isError ? " error" : "");
  element.textContent = message;
  container.append(element);
}

async function analyzeJob() {
  if (!state.job) return;
  if (!state.apiKey) {
    showToast("请先填写并验证 ElevenLabs API Key");
    return;
  }
  const confirmed = window.confirm("将调用 ElevenLabs Scribe v3 对整段视频进行一次转录和说话人识别，会产生转录 API 用量费用。是否继续？");
  if (!confirmed) return;
  ui.analyzeButton.disabled = true;
  ui.analysisPanel.hidden = false;
  ui.analysisProgress.hidden = false;
  ui.analysisProgressText.textContent = "正在提取音轨并进行 Scribe v3 说话人识别";
  setStep(2);
  try {
    await request("/api/jobs/" + state.job.id + "/analyze", { method: "POST", headers: apiKeyHeaders() });
    await pollJob("analysis");
  } catch (error) {
    ui.analyzeButton.disabled = false;
    renderAlert(ui.analysisAlerts, error.message, true);
  }
}

function renderAnalysis() {
  const job = state.job;
  if (!job) return;
  state.activeSegmentId = "";
  ui.analysisProgress.hidden = false;
  const progress = job.analysisProgress || 0;
  ui.analysisProgressValue.textContent = progress + "%";
  ui.analysisProgressBar.style.width = progress + "%";
  ui.analysisProgressText.textContent = job.status === "analyzing" ? "正在识别台词和人物" : "人物识别完成";

  ui.analysisAlerts.innerHTML = "";
  (job.warnings || []).forEach((warning) => renderAlert(ui.analysisAlerts, warning));
  if (job.analysisError) renderAlert(ui.analysisAlerts, job.analysisError, true);

  ui.speakerSummary.innerHTML = (job.speakers || []).map((speaker, index) =>
    '<div class="speaker-chip" data-speaker="' + escapeHtml(speaker.speakerId) + '"><div class="speaker-index">SPEAKER ' + String(index + 1).padStart(2, "0") +
    '</div><strong>' + escapeHtml(speaker.label || speaker.speakerId) +
    '</strong><small>' + escapeHtml(speaker.speakerId) + " · " + speaker.segmentCount + " 段 · " + speaker.wordCount + " 词</small></div>"
  ).join("");

  ui.segmentCount.textContent = (job.segments || []).length + " 个片段";
  ui.segmentList.innerHTML = (job.segments || []).map((segment) => {
    const speaker = (job.speakers || []).find((item) => item.speakerId === segment.speakerId);
    const flags = [];
    if (segment.overlap) flags.push('<span class="mini-tag warn">多人重叠</span>');
    if (segment.short) flags.push('<span class="mini-tag">短语句</span>');
    return '<button class="segment-row" type="button" data-segment="' + escapeHtml(segment.id) + '" data-seek="' + segment.speechStart + '" data-speaker="' + escapeHtml(segment.speakerId || "") + '" aria-label="' + escapeHtml(formatTime(segment.speechStart) + "，" + (speaker?.label || "未分配人物") + "：" + (segment.text || "未识别文字") + "，点击定位并播放") + '">' +
      '<span class="segment-time">' + formatTime(segment.speechStart) + '</span>' +
      '<span class="segment-speaker">' + escapeHtml(speaker?.label || segment.speakerId) + '</span>' +
      '<span class="segment-text">' + escapeHtml(segment.text || "（未识别文字）") + '</span>' +
      '<span class="segment-flags">' + flags.join("") + '<span class="segment-play-hint">试听片段</span></span>' +
      '</button>';
  }).join("");
  ui.transcriptEmpty.hidden = Boolean((job.segments || []).length);

  ui.segmentList.querySelectorAll("[data-seek]").forEach((button) => {
    button.addEventListener("click", () => {
      activateSegment(button.dataset.segment, button.dataset.speaker);
      seekSource(Number(button.dataset.seek), true);
    });
  });

  if ((job.speakers || []).length && (job.segments || []).length) {
    ui.mappingPanel.hidden = false;
    ui.conversionPanel.hidden = false;
    setStep(job.outputAvailable && !job.mixDirty ? 5 : 3);
    renderSpeakerMappings();
    renderConversionSummary();
  } else if (job.status === "failed") {
    renderAlert(ui.analysisAlerts, "识别阶段失败。请重新上传源视频后再试。", true);
  }
}

function activateSegment(segmentId, speakerId) {
  if (state.activeSegmentId === segmentId) return;
  state.activeSegmentId = segmentId;
  ui.segmentList.querySelectorAll(".segment-row").forEach((row) => {
    row.classList.toggle("active", row.dataset.segment === segmentId);
  });
  ui.speakerSummary.querySelectorAll(".speaker-chip").forEach((chip) => {
    chip.classList.toggle("active", Boolean(speakerId) && chip.dataset.speaker === speakerId);
  });
  const segment = state.job?.segments?.find((item) => item.id === segmentId);
  ui.activeSegmentTime.textContent = segment ? formatTime(segment.speechStart) + " · " + (segment.end - segment.start).toFixed(1) + " 秒" : "未选中片段";
}

async function loadVoices(search = ui.voiceSearch.value.trim(), append = false) {
  if (!state.apiKey) {
    state.voices = [];
    ui.voiceHint.textContent = "请先连接 ElevenLabs API Key，再读取账户音色。";
    ui.loadMoreVoicesButton.hidden = true;
    renderSpeakerMappings();
    return;
  }
  const source = ui.voiceSource.value;
  if (!append) {
    state.voicePage = 0;
    state.voicePageToken = "";
    state.voiceHasMore = false;
    ui.loadMoreVoicesButton.hidden = true;
  }
  ui.languageFilterWrap.hidden = source !== "shared";
  ui.accentFilterWrap.hidden = source !== "shared";
  ui.localeFilterWrap.hidden = source !== "shared";
  ui.voiceHint.textContent = source === "shared" ? "正在读取 ElevenLabs 共享音色库…" : "正在读取我的 ElevenLabs 音色库…";
  try {
    const params = new URLSearchParams({ source, search });
    if (source === "shared") {
      params.set("language", ui.voiceLanguage.value.trim());
      params.set("accent", ui.voiceAccent.value.trim());
      params.set("locale", ui.voiceLocale.value.trim());
      params.set("page", String(state.voicePage));
    } else if (state.voicePageToken) {
      params.set("pageToken", state.voicePageToken);
    }
    const result = await request("/api/voices?" + params.toString(), {
      headers: apiKeyHeaders(),
    });
    state.voices = append ? [...state.voices, ...(result.voices || [])] : (result.voices || []);
    state.voiceHasMore = Boolean(result.hasMore);
    if (source === "shared") state.voicePage = Number(result.nextPage ?? state.voicePage + 1);
    else state.voicePageToken = result.nextPageToken || "";
    ui.loadMoreVoicesButton.hidden = !state.voiceHasMore;
    ui.loadMoreVoicesButton.textContent = source === "shared" ? "加载更多共享音色" : "加载更多我的音色";
    const sourceName = source === "shared" ? "共享" : "我的";
    ui.voiceHint.textContent = state.voices.length
      ? "已加载 " + state.voices.length + " 个" + sourceName + "音色。" + (state.voiceHasMore ? "还有更多结果，可继续加载。" : "")
      : "当前筛选没有匹配音色。可尝试其他条件，或手动粘贴 Voice ID。";
    renderSpeakerMappings();
  } catch (error) {
    state.voices = [];
    ui.voiceHint.textContent = error.message + "；仍可手动粘贴 Voice ID。";
    renderSpeakerMappings();
  }
}

function renderSpeakerMappings() {
  const job = state.job;
  if (!job) return;
  ui.speakerMappingList.innerHTML = (job.speakers || []).map((speaker, index) => {
    const selected = state.draftMappings[speaker.speakerId] ?? job.voiceMappings?.[speaker.speakerId] ?? speaker.voiceId ?? "";
    const options = ['<option value="">选择目标音色…</option>'].concat(
      state.voices.map((voice) =>
        '<option value="' + escapeHtml(voice.voiceId) + '"' + (selected === voice.voiceId ? " selected" : "") + '>' +
        escapeHtml(voice.name) + " · ID …" + escapeHtml(String(voice.voiceId).slice(-6)) +
        (voice.category ? " · " + escapeHtml(voice.category) : "") + '</option>'
      )
    ).join("");
    const sample = speaker.sampleText ? '<p>' + escapeHtml(speaker.sampleText) + '</p>' : "";
    const sampleSegment = (job.segments || []).find((segment) => segment.id === speaker.sampleSegmentId);
    const sampleButton = sampleSegment
      ? '<button type="button" class="sample-audio-button" data-seek="' + sampleSegment.speechStart + '">试听原声片段</button>'
      : "";
    return '<article class="speaker-map-card" data-speaker="' + escapeHtml(speaker.speakerId) + '">' +
      '<div class="speaker-map-info"><strong>' + escapeHtml(speaker.label || ("人物 " + (index + 1))) + '</strong>' +
      '<small>' + escapeHtml(speaker.speakerId) + " · " + speaker.segmentCount + " 段</small>" + sample + sampleButton + '</div>' +
      '<div><label class="field-label">账户音色</label><select class="select-control voice-select">' + options + '</select><audio class="voice-preview" controls preload="none" hidden></audio></div>' +
      '<div><label class="field-label">Voice ID（可手动填写）</label><input class="voice-id-input" type="text" value="' + escapeHtml(selected) + '" placeholder="粘贴目标 Voice ID"></div>' +
      '</article>';
  }).join("");

  ui.speakerMappingList.querySelectorAll(".speaker-map-card").forEach((card) => {
    const select = card.querySelector(".voice-select");
    const input = card.querySelector(".voice-id-input");
    const preview = card.querySelector(".voice-preview");
    const updatePreview = (voiceId) => {
      const voice = state.voices.find((item) => item.voiceId === voiceId);
      if (voice?.previewUrl) {
        preview.src = voice.previewUrl;
        preview.hidden = false;
      } else {
        preview.pause();
        preview.removeAttribute("src");
        preview.hidden = true;
      }
    };
    updatePreview(input.value);
    select.addEventListener("change", async () => {
      const selectedVoice = state.voices.find((item) => item.voiceId === select.value);
      if (ui.voiceSource.value === "shared" && selectedVoice?.publicOwnerId && !selectedVoice.isAccountCopy) {
        const sourceVoiceId = selectedVoice.voiceId;
        select.disabled = true;
        ui.voiceHint.textContent = "正在将共享音色添加到你的音色库…";
        try {
          let accountVoiceId = state.sharedVoiceCopies[sourceVoiceId];
          if (!accountVoiceId) {
            const added = await request("/api/voices/shared/add", {
              method: "POST",
              headers: { ...apiKeyHeaders(), "Content-Type": "application/json" },
              body: JSON.stringify({
                publicOwnerId: selectedVoice.publicOwnerId,
                voiceId: sourceVoiceId,
                newName: selectedVoice.name,
              }),
            });
            accountVoiceId = added.voiceId;
            state.sharedVoiceCopies[sourceVoiceId] = accountVoiceId;
            state.voices.push({ ...selectedVoice, voiceId: accountVoiceId, category: "my library", isAccountCopy: true });
          }
          state.draftMappings[card.dataset.speaker] = accountVoiceId;
          input.value = accountVoiceId;
          ui.voiceHint.textContent = "共享音色已添加到你的账户并完成绑定。";
          renderSpeakerMappings();
        } catch (error) {
          select.value = "";
          input.value = "";
          state.draftMappings[card.dataset.speaker] = "";
          ui.voiceHint.textContent = "添加共享音色失败：" + error.message;
          select.disabled = false;
        }
        return;
      }
      input.value = select.value;
      state.draftMappings[card.dataset.speaker] = select.value;
      updatePreview(select.value);
    });
    input.addEventListener("input", () => {
      state.draftMappings[card.dataset.speaker] = input.value.trim();
      updatePreview(input.value.trim());
    });
    card.querySelector(".sample-audio-button")?.addEventListener("click", (event) => {
      seekSource(Number(event.currentTarget.dataset.seek), true);
    });
  });
}

function collectMappings() {
  const mappings = {};
  ui.speakerMappingList.querySelectorAll(".speaker-map-card").forEach((card) => {
    mappings[card.dataset.speaker] = card.querySelector(".voice-id-input").value.trim();
  });
  return mappings;
}

async function saveMappings() {
  if (!state.job) return false;
  ui.mappingErrors.hidden = true;
  const mappings = collectMappings();
  const owners = new Map();
  const mappingErrors = [];
  for (const speaker of state.job.speakers || []) {
    const voiceId = String(mappings[speaker.speakerId] || "").trim();
    const label = speaker.label || speaker.speakerId;
    if (!voiceId) {
      mappingErrors.push(label + " 尚未选择目标音色");
      continue;
    }
    const previous = owners.get(voiceId);
    if (previous) {
      mappingErrors.push(previous + " 与 " + label + " 使用了相同 Voice ID：" + voiceId);
    } else {
      owners.set(voiceId, label);
    }
  }
  if (mappingErrors.length) {
    ui.mappingErrors.hidden = false;
    ui.mappingErrors.textContent = mappingErrors.join("；");
    return false;
  }
  try {
    const response = await request("/api/jobs/" + state.job.id + "/speakers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mappings }),
    });
    state.job = response.job;
    state.draftMappings = { ...mappings };
    renderSpeakerMappings();
    renderConversionSummary();
    showToast("人物音色映射已保存");
    return true;
  } catch (error) {
    ui.mappingErrors.hidden = false;
    ui.mappingErrors.textContent = error.message;
    return false;
  }
}

function renderConversionSummary() {
  const job = state.job;
  if (!job) return;
  const eligible = (job.segments || []).filter((segment) => !segment.overlap);
  const overlap = (job.segments || []).length - eligible.length;
  const seconds = eligible.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0);
  const items = [
    ["待处理片段", eligible.filter((segment) => segment.status !== "completed").length],
    ["有效语音总时长", seconds.toFixed(1) + " 秒"],
    ["重叠跳过", overlap + " 段"],
  ];
  const failed = job.conversionProgress?.failed || 0;
  renderVoiceAssets();
  renderMusicSettings();
  ui.convertButton.textContent = failed > 0
    ? "重试失败片段 →"
    : eligible.every((segment) => segment.status === "completed") ? "配音片段已完成" : "生成配音片段（付费） →";
  ui.conversionSummary.innerHTML = items.map(([label, value]) =>
    '<div class="summary-item"><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(value) + '</b></div>'
  ).join("");
}

async function convertJob() {
  if (!state.job) return;
  if (!state.apiKey) {
    showToast("请先填写并验证 ElevenLabs API Key");
    return;
  }
  const saved = await saveMappings();
  if (!saved) return;
  const eligible = (state.job.segments || []).filter((segment) => !segment.overlap && segment.status !== "completed");
  if (!eligible.length) { showToast("配音已完成，请继续添加配乐并最终合成"); return; }
  const seconds = eligible.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0);
  const confirmed = window.confirm(
    "即将先检查所有目标音色的验证状态。检查通过后，才会调用 ElevenLabs Voice Changer 处理 " +
    eligible.length + " 个片段，源语音约 " + seconds.toFixed(1) +
    " 秒，并产生 API 用量费用。若有音色需要验证，系统会在付费请求前拦截。是否继续？"
  );
  if (!confirmed) return;

  ui.convertButton.disabled = true;
  ui.conversionProgress.hidden = false;
  ui.conversionAlerts.innerHTML = "";
  try {
    await request("/api/jobs/" + state.job.id + "/convert", { method: "POST", headers: apiKeyHeaders() });
    await pollJob("conversion");
  } catch (error) {
    renderAlert(ui.conversionAlerts, error.message, true);
    ui.convertButton.disabled = false;
  }
}

async function pollJob(mode) {
  clearInterval(state.pollTimer);
  const poll = async () => {
    try {
      const wasScoring = state.job.status === "scoring";
      const result = await request("/api/jobs/" + state.job.id);
      state.job = result.job;
      if (wasScoring && state.job.status !== "scoring") renderMusicSettings(true);
      if (mode === "analysis") {
        renderAnalysis();
        if (state.job.status === "analyzing") return;
        clearInterval(state.pollTimer);
        if (state.job.status === "ready") {
          await loadVoices();
          ui.mappingPanel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
      }
      renderConversion();
      if (["converting", "scoring"].includes(state.job.status)) return;
      clearInterval(state.pollTimer);
      ui.convertButton.disabled = false;
      if (state.job.outputAvailable && !state.job.mixDirty) {
        showCompare();
        ui.comparePanel.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } catch (error) {
      clearInterval(state.pollTimer);
      showToast(error.message);
      ui.analyzeButton.disabled = false;
      ui.convertButton.disabled = false;
    }
  };
  await poll();
  if ((mode === "analysis" && state.job.status === "analyzing") ||
      (mode === "conversion" && ["converting", "scoring"].includes(state.job.status))) {
    state.pollTimer = setInterval(poll, 2200);
  }
}

function renderConversion() {
  const job = state.job;
  if (!job) return;
  const progress = job.conversionProgress || { percent: 0, completed: 0, failed: 0, skippedOverlap: 0, total: 0 };
  ui.conversionProgress.hidden = false;
  ui.conversionProgressValue.textContent = progress.percent + "%";
  ui.conversionProgressBar.style.width = progress.percent + "%";
  ui.conversionProgressText.textContent = job.status === "converting" ? "正在逐段生成配音片段" : "配音素材已就绪；请继续配乐与最终合成";
  ui.conversionCounts.textContent =
    "成功 " + progress.completed + " 段 · 失败 " + progress.failed + " 段 · 重叠跳过 " +
    (progress.skippedOverlap || 0) + " 段 · 非语音跳过 " + (progress.skippedNonSpeech || 0) + " 段";
  ui.conversionAlerts.innerHTML = "";
  if (job.conversionError) renderAlert(ui.conversionAlerts, job.conversionError, job.status === "failed");
  if (job.status === "completed_with_warnings") {
    renderAlert(ui.conversionAlerts, "视频已生成，但部分重叠或失败片段没有完成逐人变声。请在下方对比检查。");
  }
  const timingWarnings = (job.segments || []).filter((segment) => segment.timingWarning).length;
  if (timingWarnings) {
    renderAlert(ui.conversionAlerts, timingWarnings + " 个片段的生成时长与原始时间段差异较大，已进行限幅变速和补齐/裁剪。");
  }
  renderConversionSummary();
  if (job.outputAvailable && !job.mixDirty) setStep(5);
  else if (job.segments.some((segment) => segment.status === "completed")) setStep(4);
}

function showCompare() {
  const job = state.job;
  if (!job?.outputAvailable || job.mixDirty) { ui.comparePanel.hidden = true; return; }
  ui.comparePanel.hidden = false;
  ui.originalVideo.src = job.originalUrl;
  ui.changedVideo.src = job.outputUrl + "?v=" + Date.now();
  ui.downloadButton.href = job.outputUrl;
  ui.downloadButton.download = "voice-changed-" + job.id.slice(0, 8) + ".mp4";
  ui.originalVideo.load();
  ui.changedVideo.load();

}

function setVideoTime(video, seconds) {
  const apply = () => { video.currentTime = seconds; };
  if (video.readyState >= 1) apply();
  else video.addEventListener("loadedmetadata", apply, { once: true });
}

function seekSource(seconds, shouldPlay = false) {
  const video = ui.sourcePreviewVideo;
  const value = Math.max(0, Math.min(Number(seconds) || 0, state.job?.media?.duration || 0));
  setVideoTime(video, value);
  if (shouldPlay) {
    if (video.readyState >= 1) video.play().catch(() => {});
    else video.addEventListener("loadedmetadata", () => video.play().catch(() => {}), { once: true });
  }
}

async function loadProjects() {
  try {
    const result = await request("/api/jobs");
    ui.savedProjects.innerHTML = '<option value="">新建视频项目</option>' + result.projects.map((project) =>
      '<option value="' + escapeHtml(project.id) + '">' + escapeHtml(project.name) + ' · ' + project.id.slice(0, 8) + '</option>',
    ).join("");
    ui.savedProjects.value = state.job?.id || "";
  } catch (error) { showToast("读取项目失败：" + error.message); }
}

let duckTimelineTimer;
let duckTimelineRequest = 0;
function collectDuckingSettings() {
  const manual = ui.manualDuck.value.trim();
  const manual_segments = manual ? manual.split(/\n+/).map((line) => {
    const match = line.trim().match(/^(\d+(?:\.\d+)?)\s*[-–—,，]\s*(\d+(?:\.\d+)?)$/);
    if (!match) throw new Error("手动区间格式应为 起点-终点，每行一段");
    return { start: Number(match[1]), end: Number(match[2]) };
  }) : null;
  return { normal_music_db: Number(ui.musicLevel.value), reduction_db: Number(ui.musicReduction.value), gap: Number(ui.duckGap.value), attack: Number(ui.duckAttack.value), release: Number(ui.duckRelease.value), pre: 0.15, post: 0.25, manual_segments };
}
function updateDuckingLabels() {
  ui.musicLevelValue.textContent = ui.musicLevel.value + " dB";
  ui.musicReductionValue.textContent = "-" + ui.musicReduction.value + " dB";
  ui.duckGapValue.textContent = Number(ui.duckGap.value).toFixed(1) + " 秒";
  ui.duckAttackValue.textContent = Math.round(ui.duckAttack.value * 1000) + " ms";
  ui.duckReleaseValue.textContent = Math.round(ui.duckRelease.value * 1000) + " ms";
  const combined = Number(ui.musicLevel.value) - Number(ui.musicReduction.value);
  ui.musicSpeechLevel.textContent = "对白期间音乐的总增益：" + ui.musicLevel.value + " − " + ui.musicReduction.value + " = " + combined + " dB（相对于校准后音乐）" + (combined <= -24 ? "。当前衰减很大，背景可能难以听见，可减小额外衰减。" : "");
}
async function refreshDuckingTimeline() {
  if (!state.job) return;
  const requestId = ++duckTimelineRequest;
  try {
    const data = await request("/api/jobs/" + state.job.id + "/ducking?settings=" + encodeURIComponent(JSON.stringify(collectDuckingSettings())));
    if (requestId !== duckTimelineRequest) return;
    for (const [lane, intervals] of [[ui.rawLane, data.raw], [ui.mergedLane, data.windows]]) {
      lane.replaceChildren();
      for (const segment of intervals) {
        const block = document.createElement("span");
        block.className = "duck-clip";
        block.style.left = (segment.start / data.duration * 100) + "%";
        block.style.width = Math.max((segment.end - segment.start) / data.duration * 100, 0.2) + "%";
        block.title = segment.start.toFixed(2) + "–" + segment.end.toFixed(2) + " 秒";
        lane.appendChild(block);
      }
    }
    ui.duckEndTime.textContent = data.duration.toFixed(1) + " 秒";
    ui.duckTimelineStatus.textContent = data.raw.length + " 个识别区间 / 合并后 " + data.segments.length + " 段讲话（已计入前后预留）";
  } catch (error) { if (requestId === duckTimelineRequest) ui.duckTimelineStatus.textContent = error.message; }
}
async function uploadMusic() {
  const file = ui.musicFile.files?.[0];
  if (!state.job || !file) { showToast("请先选择已有配乐文件"); return; }
  ui.musicUploadButton.disabled = true;
  try {
    const result = await request("/api/jobs/" + state.job.id + "/music-upload", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
    state.job = result.job; ui.musicPreview.dataset.url = ""; renderVoiceAssets(); renderMusicSettings(true);
    showToast("音乐素材已保存，请在最后一步点击生成最终成品");
  } catch (error) { showToast(error.message); }
  finally { ui.musicUploadButton.disabled = false; }
}

function renderVoiceAssets() {
  const job = state.job;
  const clips = job.segments.filter((segment) => segment.status === "completed" && segment.convertedFile);
  ui.voiceAssets.hidden = !clips.length;
  const ready = clips.length > 0 && !job.segments.some((segment) => !segment.overlap && !["completed", "failed"].includes(segment.status));
  ui.musicPanel.hidden = !ready;
  ui.finalMixPanel.hidden = !ready;
  ui.continueMusicButton.disabled = !ready;
  const signature = JSON.stringify([clips.map((segment) => segment.id), job.voiceMappings]);
  if (ui.voiceClips.dataset.signature !== signature) {
    ui.voiceClips.dataset.signature = signature;
    ui.voiceClips.innerHTML = clips.map((segment) => {
      const speaker = job.speakers.find((speaker) => speaker.speakerId === segment.speakerId);
      return '<article class="voice-clip"><b>' + escapeHtml(speaker?.label || segment.speakerId) + ' · ' + formatTime(segment.start) + '</b><span>' + escapeHtml(segment.text) + '</span><audio controls preload="none" src="' + escapeHtml(segment.convertedUrl || "/api/jobs/" + job.id + "/segment/" + segment.id + "/converted") + '"></audio></article>';
    }).join("");
  }
  ui.dialoguePreview.hidden = !job.dialoguePreviewUrl;
  if (job.dialoguePreviewUrl && ui.dialoguePreview.dataset.url !== job.dialoguePreviewUrl) {
    ui.dialoguePreview.src = job.dialoguePreviewUrl + "?v=" + Date.now(); ui.dialoguePreview.dataset.url = job.dialoguePreviewUrl;
  } else if (!job.dialoguePreviewUrl) { ui.dialoguePreview.removeAttribute("src"); ui.dialoguePreview.dataset.url = ""; }
}

async function saveMixSettings() {
  const result = await request("/api/jobs/" + state.job.id + "/mix", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speechVolume: Number(ui.speechVolume.value) / 100, musicEnabled: ui.musicEnabled.checked, autoDucking: collectDuckingSettings() }),
  });
  state.job = result.job;
}

function renderMusicSettings(restore = false) {
  const job = state.job;
  if (!job) return;
  if (restore) {
    ui.musicEnabled.checked = Boolean(job.musicEnabled);
    ui.musicDescription.value = job.musicDescription || "";
    ui.referenceAudio.checked = Boolean(job.musicReferenceAudio);
    const settings = job.autoDucking || {};
    ui.musicLevel.value = settings.normal_music_db ?? -6;
    ui.musicReduction.value = settings.reduction_db ?? 8;
    ui.duckGap.value = settings.gap ?? 1;
    ui.duckAttack.value = settings.attack ?? 0.15;
    ui.duckRelease.value = settings.release ?? 0.55;
    ui.manualDuck.value = (settings.manual_segments || []).map((s) => s.start + "-" + s.end).join("\n");
    void refreshDuckingTimeline();
  }
  updateDuckingLabels();
  if (job.lastMix) ui.mixAppliedStatus.textContent = job.lastMix.musicEnabled ? "成品已包含背景音乐 · 基础 " + job.lastMix.autoDucking.normal_music_db + " dB · 对白再降低 " + job.lastMix.autoDucking.reduction_db + " dB" : "当前成品未加入新背景音乐";
  ui.speechVolume.disabled = ui.musicEnabled.checked;
  const voiceCount = job.segments.filter((segment) => segment.status === "completed" && segment.convertedFile).length;
  const busy = ["analyzing", "converting", "scoring"].includes(job.status);
  ui.generateMusicButton.disabled = !voiceCount || busy;
  ui.musicUploadButton.disabled = !voiceCount || busy;
  ui.convertButton.disabled = busy || !job.segments.some((segment) => !segment.overlap && segment.status !== "completed");
  ui.remixButton.disabled = !voiceCount || busy || (ui.musicEnabled.checked && !job.musicReady);
  ui.musicStageStatus.textContent = job.musicReady ? "音乐素材已就绪" : "等待生成或上传音乐";
  ui.finalAssetSummary.textContent = "将使用 " + voiceCount + " 段已生成配音 · 背景：" + (ui.musicEnabled.checked ? job.musicReady ? "已保存音乐 + Auto Ducking" : "尚未准备音乐" : "原音轨（不加新音乐）");
  if (job.mixDirty) { ui.mixAppliedStatus.textContent = "素材或参数已更新，等待最终合成；音乐已生成并不代表成品已更新"; ui.comparePanel.hidden = true; }

  ui.generateMusicButton.textContent = job.musicReady ? "重新生成配乐（付费）" : "生成新配乐（付费）";
  ui.musicStatus.textContent = job.status === "scoring" ? "正在自动配乐，请等待…" : job.musicError || (job.musicReady ? "配乐已保存，可试听；调整音量后点击只重新混音即可应用，无需重新生成。" : "尚未生成配乐，请先点击生成按钮。");
  ui.musicPreview.hidden = !job.musicReady;
  if (job.musicReady && ui.musicPreview.dataset.url !== job.musicUrl) {
    ui.musicPreview.src = job.musicUrl;
    ui.musicPreview.dataset.url = job.musicUrl;
  }
}

async function generateMusic() {
  if (!state.job || !state.apiKey) { showToast("请先连接 ElevenLabs API Key"); return; }
  if (!state.job.segments.some((segment) => segment.status === "completed")) { showToast("请先完成配音片段"); return; }
  if (!window.confirm("将上传配音预览视频到 ElevenLabs Music，生成一条新的背景音乐并产生额外费用。已有变声片段会复用，不会重复调用 Voice Changer。是否继续？")) return;
  ui.generateMusicButton.disabled = true;
  ui.remixButton.disabled = true;
  ui.convertButton.disabled = true;
  ui.musicStatus.textContent = "正在根据视频生成连续配乐，请等待…";
  try {
    const result = await request("/api/jobs/" + state.job.id + "/music", {
      method: "POST", headers: { ...apiKeyHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ description: ui.musicDescription.value.trim(), referenceAudio: ui.referenceAudio.checked }),
    });
    state.job = result.job;
    ui.musicPreview.dataset.url = "";
    renderVoiceAssets();
    renderMusicSettings(true);
    showToast("音乐素材已保存，请在最后一步点击生成最终成品");
  } catch (error) { ui.musicStatus.textContent = error.message; }
  finally {
    ui.generateMusicButton.disabled = false;
    ui.convertButton.disabled = !state.job?.segments.some((segment) => !segment.overlap && segment.status !== "completed");
    ui.remixButton.disabled = !state.job?.segments.some((segment) => segment.status === "completed");
  }
}

async function remixJob() {
  if (!state.job) return;
  ui.remixButton.disabled = true;
  ui.convertButton.disabled = true;
  ui.originalVideo.pause(); ui.changedVideo.pause();
  try {
    await saveMixSettings();
    const result = await request("/api/jobs/" + state.job.id + "/remix", { method: "POST" });
    state.job = result.job;
    renderMusicSettings(); showCompare(); setStep(5); ui.comparePanel.scrollIntoView({ behavior: "smooth", block: "start" }); showToast("最终成品已更新，未重新生成配音或音乐");
  } catch (error) { showToast(error.message); }
  finally { renderMusicSettings(); }
}

async function restoreLastJob() {
  const id = new URLSearchParams(window.location.search).get("job");
  if (!/^[a-f0-9-]{36}$/i.test(id || "")) return;

  try {
    const { job } = await request("/api/jobs/" + id);
    state.job = job;
    ui.cleanupButton.disabled = false;
    state.draftMappings = { ...(job.voiceMappings || {}) };
    window.demoDiagnostics?.setJobId(job.id);
    rememberJob(job.id);

    ui.analysisPanel.hidden = false;
    ui.uploadPanel.hidden = true;
    ui.analyzeButton.disabled = job.status !== "uploaded";
    ui.sourcePreviewVideo.src = job.originalUrl;
    ui.sourcePreviewVideo.load();
    renderJobSummary();
    ui.speechVolume.value = String(Math.round((job.speechVolume ?? 0) * 100));
    ui.speechVolumeValue.textContent = ui.speechVolume.value + "%";
    renderMusicSettings(true);
    setStep(1);

    if (job.analysisProgress || (job.speakers || []).length || job.analysisError) {
      renderAnalysis();
    }
    if ((job.speakers || []).length) {
      await loadVoices();
      if (job.conversionProgress) renderConversion();
      if (job.outputAvailable) showCompare();
    }

    if (job.status === "analyzing") await pollJob("analysis");
    if (["converting", "scoring"].includes(job.status)) await pollJob("conversion");

    window.demoDiagnostics?.record({
      level: job.status === "failed" ? "warn" : "info",
      event: "job_restored", stage: "resume",
      message: "历史视频任务已恢复，状态：" + job.status +
        "；失败片段：" + (job.conversionProgress?.failed || 0),
    });
  } catch (error) {
    window.demoDiagnostics?.record({
      level: "error", event: "job_restore_failed", stage: "resume",
      message: "恢复历史任务失败：" + error.message,
    });
  }
}

async function cleanupCurrentJob() {
  if (!state.job) return;
  if (["converting", "analyzing", "scoring"].includes(state.job.status)) {
    showToast("任务正在处理，请完成后再清理");
    return;
  }
  const confirmed = window.confirm("确定清理本次任务吗？本项目持久保存的源视频、提取音频、变声片段、识别结果和输出视频都会删除。已下载到电脑的文件不会删除。");
  if (!confirmed) return;

  ui.cleanupButton.disabled = true;
  try {
    await request("/api/jobs/" + state.job.id, { method: "DELETE" });
    clearInterval(state.pollTimer);
    state.job = null;
    state.draftMappings = {};
    state.activeSegmentId = "";
    ui.musicPreview.pause();
    ui.musicPreview.removeAttribute("src");
    ui.musicPreview.dataset.url = "";
    ui.sourcePreviewVideo.pause();
    ui.sourcePreviewVideo.removeAttribute("src");
    ui.sourcePreviewVideo.load();
    ui.originalVideo.pause();
    ui.originalVideo.removeAttribute("src");
    ui.originalVideo.load();
    ui.changedVideo.pause();
    ui.changedVideo.removeAttribute("src");
    ui.changedVideo.load();
    ui.downloadButton.removeAttribute("href");
    ui.analysisPanel.hidden = true;
    ui.mappingPanel.hidden = true;
    ui.conversionPanel.hidden = true;
    ui.musicPanel.hidden = true; ui.finalMixPanel.hidden = true;
    ui.dialoguePreview.pause(); ui.dialoguePreview.removeAttribute("src"); ui.dialoguePreview.dataset.url = "";
    ui.voiceClips.replaceChildren(); ui.voiceClips.dataset.signature = "";
    ui.comparePanel.hidden = true;
    ui.analysisAlerts.innerHTML = "";
    ui.conversionAlerts.innerHTML = "";
    ui.speakerMappingList.innerHTML = "";
    ui.segmentList.innerHTML = "";
    clearFile();
    ui.uploadPanel.hidden = false;
    ui.uploadPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    const url = new URL(window.location.href);
    url.searchParams.delete("job");
    window.history.replaceState(null, "", url.pathname + url.search);
    setStep(1);
    window.demoDiagnostics?.setJobId("");
    void loadProjects();
    showToast("本项目视频数据已删除");
  } catch (error) {
    ui.cleanupButton.disabled = false;
    showToast(error.message);
  }
}

function bindEvents() {
  ui.connectApiKeyButton.addEventListener("click", connectApiKey);
  ui.clearApiKeyButton.addEventListener("click", clearApiKey);
  ui.apiKeyInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") connectApiKey();
  });
  ui.cleanupButton.addEventListener("click", cleanupCurrentJob);
  ui.changeVideoButton.addEventListener("click", () => { window.location.href = "/"; });
  ui.savedProjects.addEventListener("change", () => { window.location.href = ui.savedProjects.value ? "/?job=" + ui.savedProjects.value : "/"; });
  ui.speechVolume.addEventListener("input", () => { ui.speechVolumeValue.textContent = ui.speechVolume.value + "%"; ui.mixAppliedStatus.textContent = "原声比例已修改，请点击最终合成应用"; ui.comparePanel.hidden = true; });
  ui.remixButton.addEventListener("click", remixJob);
  ui.generateMusicButton.addEventListener("click", generateMusic);
  ui.continueMusicButton.addEventListener("click", () => ui.musicPanel.scrollIntoView({ behavior: "smooth", block: "start" }));
  ui.musicEnabled.addEventListener("change", () => { renderMusicSettings(); ui.mixAppliedStatus.textContent = "背景选择已修改，请点击最终合成应用"; ui.comparePanel.hidden = true; });
  ui.musicUploadButton.addEventListener("click", uploadMusic);
  ui.resetDuckingButton.addEventListener("click", () => {
    ui.musicLevel.value = -6; ui.musicReduction.value = 8; ui.duckGap.value = 1; ui.duckAttack.value = 0.15; ui.duckRelease.value = 0.55;
    ui.manualDuck.value = "";
    updateDuckingLabels(); void refreshDuckingTimeline();
    ui.mixAppliedStatus.textContent = "推荐参数已选中，请点击最终合成应用";
    ui.comparePanel.hidden = true;
  });
  for (const input of [ui.musicLevel, ui.musicReduction, ui.duckGap, ui.duckAttack, ui.duckRelease, ui.manualDuck]) input.addEventListener("input", () => {
    updateDuckingLabels();
    ui.mixAppliedStatus.textContent = "参数已修改，请点击最终合成更新成品";
    ui.comparePanel.hidden = true;
    clearTimeout(duckTimelineTimer); duckTimelineTimer = setTimeout(refreshDuckingTimeline, 300);
  });
  ui.fileInput.addEventListener("change", () => chooseFile(ui.fileInput.files?.[0]));
  ui.clearFileButton.addEventListener("click", clearFile);
  ui.uploadButton.addEventListener("click", uploadFile);
  ui.analyzeButton.addEventListener("click", analyzeJob);
  ui.saveMappingButton.addEventListener("click", saveMappings);
  ui.convertButton.addEventListener("click", convertJob);
  ui.reloadVoicesButton.addEventListener("click", () => loadVoices(ui.voiceSearch.value.trim()));
  ui.voiceSource.addEventListener("change", () => loadVoices());
  ui.loadMoreVoicesButton.addEventListener("click", () => loadVoices(ui.voiceSearch.value.trim(), true));
  ui.voiceSearch.addEventListener("keydown", (event) => {
    if (event.key === "Enter") loadVoices(ui.voiceSearch.value.trim());
  });
  for (const filter of [ui.voiceLanguage, ui.voiceAccent, ui.voiceLocale]) {
    filter.addEventListener("keydown", (event) => {
      if (event.key === "Enter") loadVoices();
    });
  }
  ui.dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    ui.dropzone.classList.add("dragover");
  });
  ui.dropzone.addEventListener("dragleave", () => ui.dropzone.classList.remove("dragover"));
  ui.dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    ui.dropzone.classList.remove("dragover");
    chooseFile(event.dataTransfer.files?.[0]);
  });
  document.addEventListener("play", (event) => {
    if (!["AUDIO", "VIDEO"].includes(event.target.tagName)) return;
    document.querySelectorAll("audio, video").forEach((player) => { if (player !== event.target) player.pause(); });
  }, true);
  ui.sourcePreviewVideo.addEventListener("timeupdate", () => {
    const segment = (state.job?.segments || []).find((item) =>
      ui.sourcePreviewVideo.currentTime >= item.speechStart && ui.sourcePreviewVideo.currentTime <= item.end,
    );
    if (segment) activateSegment(segment.id, segment.speakerId);
  });

}

bindEvents();
window.__voiceDemoAppBootstrapped = true;
window.demoDiagnostics?.record({ level: "info", event: "app_initialized", stage: "bootstrap", message: "页面脚本初始化完成" });
checkStatus();
void restoreLastJob().then(loadProjects);
