/* Standalone bootstrap: works even when the main app module throws during loading. */
(() => {
  "use strict";

  const localEvents = [];
  let currentJobId = "";
  let displayedEvents = [];
  let lastReport = null;

  function redact(message) {
    return String(message ?? "")
      .replace(/\b(?:xi-api-key|authorization|api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"',;&}]+/gi, "[REDACTED_FIELD]")
      .replace(/\bBearer\s+[a-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk_[a-z0-9_-]{12,}\b/gi, "[REDACTED_KEY]")
      .slice(0, 700);
  }

  function safePath(input) {
    try {
      const url = new URL(input, location.href);
      return url.origin === location.origin ? url.pathname : url.hostname + url.pathname;
    } catch {
      return String(input ?? "").split("?")[0].slice(0, 150);
    }
  }

  function record(input) {
    const event = {
      timestamp: new Date().toISOString(),
      level: ["info", "warn", "error"].includes(input?.level) ? input.level : "info",
      event: String(input?.event ?? "unknown").slice(0, 100),
      stage: String(input?.stage ?? "frontend").slice(0, 100),
      jobId: String(input?.jobId ?? currentJobId).slice(0, 72),
      requestId: String(input?.requestId ?? "").slice(0, 72),
      message: redact(input?.message),
      stack: redact(input?.stack).slice(0, 700),
      route: input?.route ? safePath(input.route) : "",
      statusCode: Number(input?.statusCode) || undefined,
    };
    localEvents.push(event);
    if (localEvents.length > 80) localEvents.shift();
    // Customer build keeps diagnostics in page memory only; nothing is written to browser storage.
    if (event.level === "error") setErrorDot();
    try {
      fetch("/api/diagnostics/client", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Never let diagnostics throw into the application.
    }
  }

  function setJobId(id) {
    currentJobId = String(id ?? "").slice(0, 72);
  }

  function setErrorDot() {
    const button = document.getElementById("debugOpenButton");
    if (button) button.dataset.hasError = "true";
  }

  window.addEventListener("error", (event) => {
    if (event.target && event.target !== window) {
      const element = event.target;
      const resource = element.getAttribute?.("src") || element.getAttribute?.("href") || "";
      record({
        level: "error", event: "asset_load_error", stage: "bootstrap",
        message: (element.tagName || "resource") + " 加载失败：" + safePath(resource),
        route: resource,
      });
      return;
    }
    record({
      level: "error",
      event: "uncaught_error",
      stage: "frontend",
      message: (event.message || "未捕获的脚本错误") + " (" + safePath(event.filename) + ":" + (event.lineno || "?") + ":" + (event.colno || "?") + ")",
      stack: event.error?.stack || "",
    });
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    record({
      level: "error", event: "unhandled_rejection", stage: "frontend",
      message: event.reason?.message || String(event.reason || "未知 Promise 错误"),
      stack: event.reason?.stack || "",
    });
  });

  window.addEventListener("load", () => {
    if (window.__voiceDemoAppBootstrapped !== true) {
      record({
        level: "error", event: "app_bootstrap_failed", stage: "bootstrap",
        message: "主应用模块未完成初始化，可能是 JS 加载、语法错误或初始化异常",
      });
    }
  });

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }

  function buildReport(events, origin) {
    return {
      generatedAt: new Date().toISOString(),
      application: "scene-recast",
      page: location.origin + location.pathname,
      jobId: currentJobId,
      userAgent: navigator.userAgent,
      origin,
      events,
    };
  }

  async function refresh() {
    const hint = document.getElementById("debugHint");
    const list = document.getElementById("debugLogList");
    if (!list) return;
    if (hint) hint.textContent = "正在读取本机诊断记录…";
    let events = localEvents;
    let origin = "session";
    try {
      const response = await fetch("/api/diagnostics?limit=200", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const payload = await response.json();
      const serverEvents = payload.events || [];
      events = serverEvents.length ? serverEvents : localEvents;
      origin = "server";
      if (hint) hint.textContent = "本机自动记录 · 最多展示最近 200 条 · " + (currentJobId ? "当前任务 " + currentJobId.slice(0, 8) : "尚未上传视频");
    } catch (error) {
      if (hint) hint.textContent = "无法读取服务端日志，正在显示浏览器临时记录：" + redact(error.message);
    }

    displayedEvents = events;
    lastReport = buildReport(events, origin);
    if (!events.length) {
      list.innerHTML = '<p class="debug-empty">目前没有事件记录。可以继续操作 Demo，错误会自动出现在这里。</p>';
      return;
    }
    list.innerHTML = [...events].reverse().map((item) => {
      const time = new Date(item.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
      return '<article class="debug-event ' + escapeHtml(item.level) + '">' +
        '<div class="debug-event-head"><span>' + escapeHtml(time) + ' · ' +
        escapeHtml(item.source || "client") + ' · ' + escapeHtml(item.stage || "—") + '</span>' +
        '<b>' + escapeHtml(item.level) + '</b></div>' +
        '<div>' + escapeHtml(item.message || item.event || "—") + '</div>' +
        (item.statusCode ? '<small>HTTP ' + escapeHtml(item.statusCode) + '</small>' : '') +
        (item.requestId ? '<small>Request ' + escapeHtml(item.requestId) + '</small>' : '') +
        (item.jobId ? '<small>Job ' + escapeHtml(item.jobId.slice(0, 8)) + '</small>' : '') +
        (item.stack ? '<details><summary>技术堆栈</summary><pre>' + escapeHtml(item.stack) + '</pre></details>' : '') +
        '</article>';
    }).join("");
  }

  function createReport() {
    return lastReport || buildReport(localEvents, "session");
  }

  async function copyReport() {
    const report = JSON.stringify(createReport(), null, 2);
    try {
      await navigator.clipboard.writeText(report);
      const hint = document.getElementById("debugHint");
      if (hint) hint.textContent = "报告已复制。可以直接粘贴给开发人员。";
    } catch {
      const field = document.createElement("textarea");
      field.value = report;
      field.style.position = "fixed";
      field.style.left = "-9999px";
      document.body.append(field);
      field.select();
      document.execCommand("copy");
      field.remove();
    }
  }

  function downloadReport() {
    const payload = JSON.stringify(createReport(), null, 2);
    const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = "scene-recast-debug-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function setupPanel() {
    const panel = document.getElementById("debugPanel");
    const open = document.getElementById("debugOpenButton");
    const close = document.getElementById("debugCloseButton");
    if (!panel || !open || !close) return;
    open.addEventListener("click", () => {
      panel.hidden = false;
      void refresh();
    });
    close.addEventListener("click", () => { panel.hidden = true; });
    document.getElementById("debugRefreshButton")?.addEventListener("click", refresh);
    document.getElementById("debugCopyButton")?.addEventListener("click", copyReport);
    document.getElementById("debugDownloadButton")?.addEventListener("click", downloadReport);
    panel.addEventListener("click", (event) => {
      if (event.target === panel) panel.hidden = true;
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") panel.hidden = true;
    });
    // No browser storage is read in this build.
  }

  window.demoDiagnostics = { record, refresh, setJobId };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setupPanel);
  else setupPanel();
})();
