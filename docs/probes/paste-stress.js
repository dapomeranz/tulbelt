// Stress harness for paste-trigger-anywhere: every cached source trigger
// against every paste destination on screen (docs/paste-trigger-anywhere.md).
// Paste into the DevTools console of an app editor tab, page ("top") context,
// with the toggle ON.
//
// WARNING: every accepted paste CREATES A REAL TRIGGER on the server. A full
// run makes dozens. Use a scratch app VERSION you can throw away afterwards —
// deleting the version is far quicker than deleting the triggers.
//
// Why it can do this without navigating back and forth: the toggle caches
// whatever goes through Clipboard.write, and it captures from the argument
// before calling through — so a programmatic write seeds that cache even when
// the write itself is refused for want of focus. Sources are collected once,
// kept in sessionStorage (so they survive switching panels), and any of them
// can then be aimed at any destination button on screen.
//
//   __stress.help()
//   __stress.captureHere()      // collect every trigger in this panel as a source
//   __stress.sources()          // what's cached so far
//   __stress.destinations()     // paste buttons on screen right now
//   await __stress.run()        // every cached source x every destination here
//   copy(__stress.report())
//   __stress.forget()           // clear the cache
//
// Collect sources from each surface first (app tab, a step, a button, a text
// input, a custom widget), then go to each destination panel in turn and run.

(() => {
  if (window.__stress) {
    console.log("[stress] already loaded — reload the tab to reinstall");
    return;
  }

  const CLIP_ATTR = "data-tulip-clipboard";
  const STORE_KEY = "tulbelt-stress-sources";
  const BUTTON_SEL = "[data-tulbelt-pta-paste]";
  const results = [];
  let lastWrite = null;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── payload encode/decode, mirroring Tulip's own ──────────────────────────
  function encode(payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    return "<span " + CLIP_ATTR + '="' + btoa(binary) + '"></span>';
  }

  function decode(html) {
    const el = new DOMParser()
      .parseFromString(String(html), "text/html")
      .querySelector("[" + CLIP_ATTR + "]");
    if (!el) return null;
    const b64 = el.getAttribute(CLIP_ATTR);
    if (!b64) return null;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // ── watch clipboard writes (ours and Tulip's) ─────────────────────────────
  const clipProto = window.Clipboard && window.Clipboard.prototype;
  const originalWrite = clipProto && clipProto.write;
  if (originalWrite) {
    clipProto.write = function (items, ...rest) {
      try {
        const item = (items || []).find((i) => i && i.types && i.types.includes("text/html"));
        if (item) {
          lastWrite = item
            .getType("text/html")
            .then((b) => b.text())
            .then(decode)
            .catch(() => null);
        }
      } catch (_) {}
      return originalWrite.call(this, items, ...rest);
    };
  }

  // ── watch the paste API so a refusal is visible ───────────────────────────
  const apiCalls = [];
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__stressUrl = String(url || "");
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (/\/paste(\?|$)/.test(this.__stressUrl || "")) {
      this.addEventListener("loadend", () => {
        apiCalls.push({ at: Date.now(), status: this.status });
      });
    }
    return originalSend.call(this, body);
  };

  // ── sources ───────────────────────────────────────────────────────────────
  function loadSources() {
    try {
      return JSON.parse(sessionStorage.getItem(STORE_KEY) || "{}");
    } catch (_) {
      return {};
    }
  }

  function saveSources(map) {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(map));
    } catch (err) {
      console.warn("[stress] could not persist sources:", String(err));
    }
  }

  function headingOf(el) {
    const group = el.closest('[class*="triggerGroupStyles"]');
    const heading = group && group.querySelector('[class*="triggerHeaderLabel"]');
    const text = heading ? heading.textContent.trim() : "";
    return text || "(no section)";
  }

  function copyButtonsHere() {
    const out = [];
    for (const row of document.querySelectorAll(
      '[class*="triggerRow"], [class*="triggerItem"], [data-testid^="view-trigger"]',
    )) {
      for (const btn of row.querySelectorAll('button, [role="button"]')) {
        const label = [
          btn.getAttribute("aria-label"),
          btn.getAttribute("title"),
          btn.getAttribute("data-testid"),
        ]
          .filter(Boolean)
          .join(" ");
        if (!label || /cut|delete|remove/i.test(label) || !/copy/i.test(label)) continue;
        out.push({ row, btn });
        break;
      }
    }
    return out;
  }

  // ── destinations ──────────────────────────────────────────────────────────
  function destinationsHere() {
    return [...document.querySelectorAll(BUTTON_SEL)].map((btn) => ({
      btn,
      declared: btn.getAttribute("data-tulbelt-pta-paste"),
      section: headingOf(btn) === "(no section)" ? "Triggers (panel)" : headingOf(btn),
    }));
  }

  // ── reading the outcome ───────────────────────────────────────────────────
  // The trigger editor's "When" is a native <select>; its selected option says
  // where the trigger actually landed, which is the real assertion here.
  function readWhen() {
    for (const select of document.querySelectorAll("select")) {
      const option = select.options[select.selectedIndex];
      const text = option ? option.textContent.trim() : "";
      if (!text) continue;
      if (/is (started|completed|cancelled|opened|closed|pressed|exited|selected)|timer|device|machine|event occurs|input changes/i.test(text)) {
        return { when: text, options: [...select.options].map((o) => o.textContent.trim()) };
      }
    }
    return { when: null, options: [] };
  }

  function closeEditor() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    for (const btn of document.querySelectorAll('button[aria-label]')) {
      if (/^(close|cancel)$/i.test(btn.getAttribute("aria-label") || "")) {
        btn.click();
        return;
      }
    }
  }

  async function setClipboard(payload) {
    const html = encode(payload);
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }) }),
      ]);
    } catch (_) {
      // Refused for focus — the toggle's hook still captured the payload from
      // the argument, which is all this needs.
    }
    await wait(150);
  }

  window.__stress = {
    help() {
      console.log(
        [
          "1. On each source surface:  __stress.captureHere()",
          "2. On each destination panel:  await __stress.run()",
          "3. copy(__stress.report())",
          "",
          "__stress.sources() / .destinations() / .forget()",
        ].join("\n"),
      );
    },

    async captureHere(prefix) {
      const found = copyButtonsHere();
      if (!found.length) return "no trigger rows with a copy button here";
      const map = loadSources();
      let added = 0;
      for (const { row, btn } of found) {
        lastWrite = null;
        btn.click();
        await wait(300);
        const payload = lastWrite ? await lastWrite : null;
        if (!payload || !payload.trigger) continue;
        const name = (payload.trigger.name || "?").slice(0, 40);
        const key = (prefix ? prefix + " / " : "") + headingOf(row) + " / " + name;
        map[key] = payload;
        added++;
        console.log("[stress] captured", key, JSON.stringify(payload.trigger.event));
      }
      saveSources(map);
      return added + " captured, " + Object.keys(map).length + " cached total";
    },

    sources() {
      const map = loadSources();
      return Object.keys(map).map((k) => k + "  " + JSON.stringify(map[k].trigger.event));
    },

    destinations() {
      return destinationsHere().map((d) => d.section + "  [" + d.declared + "]");
    },

    forget() {
      sessionStorage.removeItem(STORE_KEY);
      return "cleared";
    },

    // Every cached source against every destination visible right now.
    async run({ sourceFilter, destinationFilter, settleMs = 1800 } = {}) {
      const map = loadSources();
      const sourceKeys = Object.keys(map).filter(
        (k) => !sourceFilter || k.toLowerCase().includes(sourceFilter.toLowerCase()),
      );
      const destinations = destinationsHere().filter(
        (d) => !destinationFilter || d.section.toLowerCase().includes(destinationFilter.toLowerCase()),
      );
      if (!sourceKeys.length) return "no cached sources — run __stress.captureHere() first";
      if (!destinations.length) return "no paste buttons on screen — is the toggle on?";

      console.log(
        "[stress] " + sourceKeys.length + " source(s) x " + destinations.length + " destination(s)",
      );

      for (const key of sourceKeys) {
        for (const destination of destinations) {
          await setClipboard(map[key]);
          const before = apiCalls.length;
          destination.btn.click();
          await wait(settleMs);

          const call = apiCalls[apiCalls.length - 1];
          const status = apiCalls.length > before && call ? call.status : null;
          const { when, options } = readWhen();
          const buttonText = (destination.btn.textContent || "").trim();

          const row = {
            source: key,
            sourceEvent: map[key].trigger.event,
            destination: destination.section,
            declared: destination.declared,
            apiStatus: status,
            when,
            whenOptionCount: options.length,
            // The button shows a message instead of its icon when it refused.
            buttonMessage: buttonText || null,
            verdict:
              status && status >= 200 && status < 300
                ? when
                  ? "pasted — When: " + when
                  : "pasted, no When read"
                : buttonText
                  ? "refused: " + buttonText
                  : "no API call",
          };
          results.push(row);
          console.log("[stress]", row.destination, "<-", key, "=>", row.verdict);

          closeEditor();
          await wait(600);
        }
      }
      return results.length + " result(s) — run copy(__stress.report())";
    },

    report() {
      const lines = results.map(
        (r) =>
          [
            r.source,
            "->",
            r.destination,
            "|",
            r.apiStatus == null ? "no call" : r.apiStatus,
            "|",
            r.when || "-",
            r.buttonMessage ? "| " + r.buttonMessage : "",
          ].join(" "),
      );
      const json = JSON.stringify({ table: lines, results }, null, 2)
        .split(location.hostname)
        .join("your-instance.tulip.co");
      window.__stressJson = json;
      console.log(lines.join("\n"));
      return json;
    },
  };

  console.log("[stress] loaded. __stress.help() for the sequence.");
})();
