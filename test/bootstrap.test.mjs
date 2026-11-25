import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("independent diagnostic panel survives when main app script never initializes", async () => {
  const source = await readFile(new URL("../public/diagnostics.js", import.meta.url), "utf8");
  const listeners = new Map();
  const buttons = new Map();

  function element(name) {
    if (!buttons.has(name)) {
      const handlers = {};
      buttons.set(name, {
        hidden: name === "debugPanel",
        dataset: {},
        textContent: "",
        innerHTML: "",
        handlers,
        addEventListener(type, callback) { handlers[type] = callback; },
        click() { handlers.click?.({ target: this }); },
      });
    }
    return buttons.get(name);
  }

  const events = [];
  const store = new Map();
  const document = {
    readyState: "complete",
    getElementById: element,
    addEventListener() {},
  };
  const window = {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
  };

  const context = {
    window,
    document,
    navigator: { userAgent: "node-qa" },
    location: { href: "http://127.0.0.1:3218/", origin: "http://127.0.0.1:3218", pathname: "/" },
    sessionStorage: {
      getItem(key) { return store.get(key); },
      setItem(key, value) { store.set(key, value); },
    },
    URL,
    setTimeout: () => 0,
    clearTimeout() {},
    fetch: async (route, options = {}) => {
      if (options.method === "POST") {
        events.push(JSON.parse(options.body));
        return { ok: true, status: 201 };
      }
      return { ok: true, json: async () => ({ events }) };
    },
  };
  runInNewContext(source, context, { filename: "diagnostics.js" });
  assert.equal(typeof window.demoDiagnostics.record, "function");
  assert.equal(element("debugPanel").hidden, true);

  // No main app script ran. The bootstrap still reports a missing initialization.
  for (const handler of listeners.get("load") || []) handler();
  assert.ok(events.some((item) => item.event === "app_bootstrap_failed"));

  for (const handler of listeners.get("error") || []) {
    handler({
      target: window,
      message: "ReferenceError: demo is not defined",
      filename: "http://127.0.0.1:3218/assets/app.js",
      lineno: 97,
      colno: 11,
      error: { stack: "ReferenceError at app.js:97:11" },
    });
  }

  assert.ok(events.some((item) => item.event === "uncaught_error"));
  assert.equal(element("debugOpenButton").dataset.hasError, "true");
  element("debugOpenButton").click();
  assert.equal(element("debugPanel").hidden, false);

  await window.demoDiagnostics.refresh();
  assert.match(element("debugLogList").innerHTML, /ReferenceError/);
  element("debugCloseButton").click();
  assert.equal(element("debugPanel").hidden, true);
});
