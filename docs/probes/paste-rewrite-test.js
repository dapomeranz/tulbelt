// Feasibility test for the Paste Trigger Anywhere toggle
// (docs/paste-trigger-anywhere.md). Paste into the DevTools console of an app
// editor tab, page ("top") context.
//
// THE QUESTION: Tulip's paste dispatcher routes a trigger by its own class —
// app triggers to the app level, step triggers to the current step, widget
// triggers to the selected widget — and the paste itself is a server API call.
// So does rewriting `trigger.event` in the clipboard payload actually get a
// trigger onto a different surface, or does the API refuse it?
//
// WARNING: a successful attempt CREATES A REAL TRIGGER on the server, in the
// app version you have open. Use a scratch app version.
//
// How it works:
//   * hooks Clipboard.write to capture the payload of your next copy click —
//     no clipboard read, so no focus or permission trouble
//   * rewrites the binding — `trigger.event` AND the stepId/widgetId pair the
//     dispatcher appears to classify on — then dispatches a paste carrying it,
//     entering Tulip's dispatcher at the same door a real paste does
//   * reads the verdict off the paste API call's status and response body.
//     NOT off the console: Tulip's logger holds a console reference taken
//     before this script loads, so its lines never reach a late hook.
//
// Usage:
//   __pasteTest.arm()                       // then click a trigger row's copy icon
//   __pasteTest.show()                      // what was captured, and its class
//   __pasteTest.tryAs('button-press', { widgetId: '<target widget>' })
//   __pasteTest.tryAs('step-open', { stepId: '<target step>' })
//   __pasteTest.tryAs('app-start')
//   __pasteTest.tryAs('interval', { stepId: '…', args: { interval: 30 } })
//   __pasteTest.tryAs('custom-widget-event', { widgetId: '…', eventName: '…', customWidgetId: '…' })
//   copy(__pasteTest.report())
//   __pasteTest.stop()                      // remove every hook
//
// Omitted ids fall back to the copied trigger's own, which is right when the
// destination is in the step you copied from and wrong otherwise.

(() => {
  if (window.__pasteTest) {
    console.log("[test] already loaded — run __pasteTest.stop() first");
    return;
  }

  const CLIP_ATTR = "data-tulip-clipboard";
  const log = [];
  const attempts = [];
  const restores = [];
  let captured = null; // { html, payload }

  const now = () => new Date().toISOString().slice(11, 23);
  const rec = (tag, data) => {
    log.push({ t: now(), tag, data });
  };

  // ── Tulip's own encoding, mirrored exactly ────────────────────────────────
  function encodePayload(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    return "<span " + CLIP_ATTR + '="' + btoa(binary) + '"></span>';
  }

  function decodePayload(html) {
    const el = new DOMParser().parseFromString(html, "text/html").querySelector("[" + CLIP_ATTR + "]");
    if (!el) return null;
    const b64 = el.getAttribute(CLIP_ATTR);
    if (!b64) return null;
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // ── capture the next copy ─────────────────────────────────────────────────
  const clipProto = window.Clipboard && window.Clipboard.prototype;
  const originalWrite = clipProto && clipProto.write;
  if (originalWrite) {
    clipProto.write = function (items, ...rest) {
      try {
        const item = (items || []).find((i) => i && i.types && i.types.includes("text/html"));
        if (item) {
          item
            .getType("text/html")
            .then((b) => b.text())
            .then((html) => {
              const payload = decodePayload(html);
              if (payload && payload.trigger) {
                captured = { html, payload };
                const ev = payload.trigger.event || {};
                console.log(
                  "[test] captured " +
                    JSON.stringify({
                      name: payload.trigger.name,
                      event: ev,
                      stepId: payload.trigger.stepId ?? null,
                      widgetId: payload.trigger.widgetId ?? null,
                    }),
                );
                rec("captured", { event: ev, name: payload.trigger.name });
              }
            })
            .catch(() => {});
        }
      } catch (_) {}
      return originalWrite.call(this, items, ...rest);
    };
    restores.push(() => {
      if (clipProto.write !== originalWrite) clipProto.write = originalWrite;
    });
  }

  // ── watch Tulip's own copy/paste logging ──────────────────────────────────
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level];
    if (typeof original !== "function") continue;
    const patched = function (...args) {
      try {
        const first = typeof args[0] === "string" ? args[0] : "";
        if (/\[Copy\/[Pp]aste\]|paste/i.test(first) && !first.startsWith("[test]")) {
          let context = null;
          try {
            context = args[1] && typeof args[1] === "object" ? JSON.parse(JSON.stringify(args[1])) : null;
          } catch (_) {}
          rec("tulip." + level, { message: first.slice(0, 300), context });
        }
      } catch (_) {}
      return original.apply(this, args);
    };
    console[level] = patched;
    restores.push(() => {
      if (console[level] === patched) console[level] = original;
    });
  }

  // ── watch the paste API call ──────────────────────────────────────────────
  const RELEVANT = /paste|trigger/i;
  // OpenTelemetry spans mention every URL the page touches, including /paste.
  const TELEMETRY = /telemetry|\/traces/i;

  const originalFetch = window.fetch;
  window.fetch = async function (input, init, ...rest) {
    const url = typeof input === "string" ? input : input && input.url;
    const body = init && typeof init.body === "string" ? init.body : null;
    const interesting =
      !TELEMETRY.test(String(url)) && (RELEVANT.test(String(url)) || (body && RELEVANT.test(body)));
    const response = await originalFetch.call(this, input, init, ...rest);
    if (interesting) {
      let text = null;
      try {
        text = await response.clone().text();
      } catch (_) {}
      rec("fetch", {
        url: String(url).slice(0, 300),
        status: response.status,
        ok: response.ok,
        isPasteApi: /\/paste(\?|$)/.test(String(url)),
        requestBody: body ? body.slice(0, 2000) : null,
        responseBody: text ? text.slice(0, 2000) : null,
      });
      console.log("[test] paste-ish fetch", response.status, String(url).slice(0, 120));
    }
    return response;
  };
  restores.push(() => {
    window.fetch = originalFetch;
  });

  // The response body is where the server explains a refusal, and it is not
  // always text: reading .responseText throws outright when responseType is
  // "blob", which is how Tulip's API client asks for it.
  async function readXhrBody(xhr) {
    try {
      if (xhr.responseType === "" || xhr.responseType === "text") return xhr.responseText;
      if (xhr.responseType === "json") return JSON.stringify(xhr.response);
      if (xhr.response && typeof xhr.response.text === "function") return await xhr.response.text();
      return "(responseType: " + xhr.responseType + ")";
    } catch (err) {
      return "(unreadable: " + String(err) + ")";
    }
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__testUrl = url;
    this.__testMethod = method;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const url = String(this.__testUrl || "");
    const bodyText = typeof body === "string" ? body : null;
    if (!TELEMETRY.test(url) && (RELEVANT.test(url) || (bodyText && RELEVANT.test(bodyText)))) {
      this.addEventListener("loadend", async () => {
        const responseBody = await readXhrBody(this);
        rec("xhr", {
          url: url.slice(0, 300),
          method: this.__testMethod,
          status: this.status,
          isPasteApi: /\/paste(\?|$)/.test(url),
          requestBody: bodyText ? bodyText.slice(0, 4000) : null,
          responseBody: String(responseBody || "").slice(0, 4000),
        });
        console.log("[test] api", this.status, url.slice(0, 120), String(responseBody).slice(0, 300));
      });
    }
    return originalSend.call(this, body);
  };
  restores.push(() => {
    XMLHttpRequest.prototype.open = originalOpen;
    XMLHttpRequest.prototype.send = originalSend;
  });

  // ── the rewrite ───────────────────────────────────────────────────────────
  // Keep every field Tulip's entry guards read (sourceCustomer, workspace,
  // queryIds, recordPlaceholders) exactly as copied. Touch the binding only:
  // trigger.event, and the stepId/widgetId pair that decides which branch of
  // the dispatcher the trigger takes.
  const NEEDS_ARGS = { interval: true, "device-output": true };
  const CUSTOM = "custom-widget-event";

  const EVENT_CLASS = {
    "app-start": "app",
    "app-complete": "app",
    "app-cancel": "app",
    "step-open": "step",
    "step-closed": "step",
    interval: "step",
    "device-output": "step",
    "machine-output": "step",
    "button-press": "widget",
    "custom-widget-event": "widget",
    "input-change": "widget",
    "input-exit": "widget",
    "enter-press": "widget",
    "row-select": "widget",
    "signature-complete": "widget",
  };

  function rewrite(payload, type, opts = {}) {
    const klass = EVENT_CLASS[type];
    if (!klass) throw new Error("unknown event type: " + type);

    const next = JSON.parse(JSON.stringify(payload));
    // `event.id` names an event SLOT, and a rewritten payload carries the
    // source's. The server accepts that, but the trigger editor may populate
    // its "When" dropdown from it — so make it switchable: pass eventId to use
    // a specific slot (the destination's), or "random" for a fresh one. The
    // codec requires the key, so it can never simply be omitted.
    const sourceId = next.trigger.event && next.trigger.event.id;
    const id =
      opts.eventId === "random"
        ? Array.from({ length: 17 }, () =>
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
              Math.floor(Math.random() * 62),
            ),
          ).join("")
        : opts.eventId || sourceId;
    const event = { id, type };

    if (type === CUSTOM) {
      if (!opts.eventName || !opts.customWidgetId) {
        throw new Error(
          "custom-widget-event needs { eventName, customWidgetId } from the TARGET widget",
        );
      }
      event.eventName = opts.eventName;
      event.customWidgetId = opts.customWidgetId;
    }
    if (NEEDS_ARGS[type]) {
      event.args = opts.args || (type === "interval" ? { interval: 30 } : {});
    }
    next.trigger.event = event;

    // The dispatcher classifies by these, not by event.type — an app trigger
    // has neither id, a step trigger has stepId only, a widget trigger has
    // both. Two details matter and both were learned the hard way:
    //
    //   * the ids must be ABSENT, not null. A null fails Tulip's own client
    //     codec ("Clipboard content was not valid AppClipboardContent") and no
    //     request is made at all — which looks exactly like a silent refusal.
    //   * `haltOnError` is carried by app- and step-class records and NOT by
    //     widget-class ones, so it moves with the class.
    if (klass === "app") {
      delete next.trigger.stepId;
      delete next.trigger.widgetId;
      next.trigger.haltOnError = true;
    } else if (klass === "step") {
      next.trigger.stepId = opts.stepId || next.trigger.stepId || next.sourceStepId;
      delete next.trigger.widgetId;
      next.trigger.haltOnError = true;
    } else {
      next.trigger.stepId = opts.stepId || next.trigger.stepId || next.sourceStepId;
      next.trigger.widgetId = opts.widgetId || next.trigger.widgetId;
      delete next.trigger.haltOnError;
    }
    return next;
  }

  function classOf(trigger) {
    if (trigger.widgetId != null) return "widget (widgetId set)";
    if (trigger.stepId != null) return "step (stepId set, no widgetId)";
    return "app (neither id set)";
  }

  // ── dispatching a paste Tulip will pick up ────────────────────────────────
  function dispatchPaste(html) {
    const data = new DataTransfer();
    data.setData("text/html", html);
    const target =
      document.querySelector("#cssCanvas") ||
      document.querySelector('[data-testid="widget"]') ||
      document.body;
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    target.dispatchEvent(event);
    return { target: target.id || target.tagName, defaultPrevented: event.defaultPrevented };
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  window.__pasteTest = {
    arm() {
      captured = null;
      console.log("[test] armed — now click the copy icon on the trigger you want to move");
      return "armed";
    },

    show() {
      if (!captured) return "nothing captured yet — run __pasteTest.arm() and click a copy icon";
      const t = captured.payload.trigger;
      return JSON.stringify(
        {
          name: t.name,
          event: t.event,
          stepId: t.stepId ?? null,
          widgetId: t.widgetId ?? null,
          dispatcherSeesThisAs: classOf(t),
        },
        null,
        2,
      );
    },

    async tryAs(type, options = {}) {
      if (!captured) return "nothing captured — run __pasteTest.arm() and click a copy icon first";
      const before = log.length;
      let payload;
      try {
        payload = rewrite(captured.payload, type, options);
      } catch (err) {
        return String(err.message || err);
      }

      const html = encodePayload(payload);
      rec("attempt", { type, options, from: captured.payload.trigger.event });
      const dispatch = dispatchPaste(html);
      console.log("[test] dispatched paste as", type, dispatch);

      await wait(3500);

      // The verdict comes from the paste API call, not from the console:
      // Tulip's logger holds its own console reference taken before this script
      // loaded, so its lines never reach our hook.
      const since = log.slice(before);
      const pasteCalls = since.filter((e) => (e.tag === "xhr" || e.tag === "fetch") && e.data.isPasteApi);
      const call = pasteCalls[pasteCalls.length - 1];

      let verdict;
      if (!call) {
        verdict = dispatch.defaultPrevented
          ? "NO API CALL — Tulip handled the paste but bailed before calling the server " +
            "(usually: the branch it chose had no target — e.g. the widget branch with nothing selected)"
          : "IGNORED — Tulip never handled the synthetic paste; try __pasteTest.button(…)";
      } else if (call.data.status >= 200 && call.data.status < 300) {
        verdict = "ACCEPTED — the server created the trigger (status " + call.data.status + ")";
      } else {
        verdict =
          "REFUSED by the server — status " +
          call.data.status +
          " — " +
          String(call.data.responseBody || "").slice(0, 300);
      }

      attempts.push({
        type,
        options,
        verdict,
        sentAs: { event: payload.trigger.event, class: classOf(payload.trigger) },
        entries: since,
      });
      console.log("[test] " + verdict);
      for (const e of since) console.log("   ", e.tag, JSON.stringify(e.data).slice(0, 600));
      return verdict;
    },

    // Fallback if the synthetic paste is ignored: writes the rewritten payload
    // to the real clipboard from a real click, then you press Ctrl+V yourself.
    button(type, options = {}) {
      if (!captured) return "nothing captured yet";
      const existing = document.getElementById("tulbelt-paste-test-button");
      if (existing) existing.remove();
      const btn = document.createElement("button");
      btn.id = "tulbelt-paste-test-button";
      btn.textContent = "Copy rewritten payload (" + type + ")";
      btn.style.cssText =
        "position:fixed;z-index:2147483647;bottom:16px;right:16px;padding:10px 14px;" +
        "background:#0065ff;color:#fff;border:0;border-radius:6px;font:600 13px system-ui;cursor:pointer";
      btn.addEventListener("click", async () => {
        try {
          const html = encodePayload(rewrite(captured.payload, type, options));
          await navigator.clipboard.write([
            new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }) }),
          ]);
          btn.textContent = "Copied — now press Ctrl/Cmd+V";
          rec("button-write", { type, options });
        } catch (err) {
          btn.textContent = "Failed: " + String(err.message || err);
        }
      });
      document.body.appendChild(btn);
      return "button added bottom-right — click it, then press Ctrl/Cmd+V on the target";
    },

    report() {
      const json = JSON.stringify({ attempts, log }, null, 2)
        .split(location.hostname)
        .join("your-instance.tulip.co");
      window.__pasteTestJson = json;
      return json;
    },

    stop() {
      document.getElementById("tulbelt-paste-test-button")?.remove();
      while (restores.length) {
        try {
          restores.pop()();
        } catch (_) {}
      }
      delete window.__pasteTest;
      return "hooks removed";
    },
  };

  console.log(
    "[test] loaded. WARNING: a successful paste creates a real trigger — use a scratch app version.\n" +
      "  1. __pasteTest.arm()   then click a trigger's copy icon\n" +
      "  2. select a target (widget for button-press, any step for step-open)\n" +
      "  3. await __pasteTest.tryAs('button-press')",
  );
})();
