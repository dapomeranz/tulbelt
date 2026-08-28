// Throwaway source-grep probe for the trigger copy/paste investigation
// (docs/paste-trigger-anywhere.md). Paste into the DevTools console of a
// tulip.co tab, page ("top") context.
//
// Tulip ships its editor as a handful of large JS bundles the tab has already
// downloaded. Re-fetching them (from cache) and grepping for the strings we
// know appear in the clipboard payload lands us next to the code that reads it
// — which is the fastest way to learn the vocabulary that payload is written
// in: every trigger event type, and what the paste handler compares before it
// agrees to open the trigger editor.
//
// Reads only. Nothing is patched, so there is nothing to undo.
//
//   __grep()                      — the default terms below
//   __grep(['some-string'], 300)  — custom terms, custom context window
//
// Then `copy(__grepJson)`. The output redacts the instance hostname, but read
// it before sending: bundles are Tulip's code, so keep the paste to what the
// terms actually matched.

(() => {
  const DEFAULT_TERMS = [
    // The clipboard envelope — lands on the code that writes and reads it.
    "isTulipAppClipboardContent",
    "data-tulip-clipboard",
    // The log lines that bracket a paste; the refusal sits between them.
    "Pasting trigger, opening trigger editor",
    // The one trigger event type we know, to find the full enum around it.
    "button-press",
  ];

  const MAX_HITS_PER_TERM = 6;
  const MAX_TOTAL_CHARS = 400000;

  async function bundleTexts() {
    const urls = [...new Set([...document.querySelectorAll("script[src]")].map((s) => s.src))];
    const out = [];
    for (const url of urls) {
      if (!url.startsWith(location.origin)) continue;
      try {
        const text = await (await fetch(url)).text();
        out.push({ url, text });
      } catch (err) {
        console.warn("[grep] could not fetch", url, String(err));
      }
    }
    return out;
  }

  window.__grep = async (terms = DEFAULT_TERMS, window_ = 400) => {
    const bundles = await bundleTexts();
    console.log(
      "[grep] searching",
      bundles.length,
      "bundles,",
      bundles.reduce((n, b) => n + b.text.length, 0),
      "chars",
    );

    const results = [];
    for (const term of terms) {
      const hits = [];
      for (const { url, text } of bundles) {
        let from = 0;
        let at;
        while ((at = text.indexOf(term, from)) !== -1 && hits.length < MAX_HITS_PER_TERM) {
          hits.push({
            file: url.split("/").pop(),
            offset: at,
            context: text.slice(Math.max(0, at - window_), at + term.length + window_),
          });
          from = at + term.length;
        }
        if (hits.length >= MAX_HITS_PER_TERM) break;
      }
      results.push({ term, hitCount: hits.length, hits });
      console.log("[grep]", term, "→", hits.length, "hit(s)");
    }

    let json = JSON.stringify({ url: location.pathname, results }, null, 2)
      .split(location.hostname)
      .join("your-instance.tulip.co");
    if (json.length > MAX_TOTAL_CHARS) {
      json = json.slice(0, MAX_TOTAL_CHARS) + "\n…truncated";
    }
    window.__grepJson = json;
    console.log("[grep] done — run copy(__grepJson)");
    return json;
  };

  console.log("[grep] loaded. Run: await __grep()  then  copy(__grepJson)");
})();
