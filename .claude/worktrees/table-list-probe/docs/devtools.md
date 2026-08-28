# Dev Tools — debugging toggles without a browser

Coding agents working on Tulbelt have no access to the user's browser. This is
the round-trip contract that replaces it: the agent writes capture code, the
user reproduces and exports a JSON report from the live tulip.co page, and
pastes it back to the agent.

The tool is the developer-only `dev-tools` toggle (`toggles/devtools.js`). It
defines `window.__tulbelt` in the extension's **isolated world** with a shared
log buffer, DOM-inspection helpers, and a redacted one-command export. It never
modifies the page; switching it off disconnects all watchers and clears the
buffer (clean revert, but an accidental off loses the captured session).

## The workflow

**Agent side** — two ways to capture, usable together:

1. **Probe**: replace the body of `toggles/dev-probe.js` (a permanently
   registered no-op stub that runs after every toggle) with throwaway capture
   code built from the helpers below.
2. **Inline logging**: in the toggle under development, add
   `window.__tulbelt?.log?.('my-feature', ...)` calls. The optional chaining
   means they no-op safely if Dev Tools is off or absent. **Don't retrofit
   existing toggles onto the logger** — their own debug consoles stay as-is.

**User side** — the agent relays these steps verbatim:

1. Open the Tulbelt popup and click the **Tulbelt** title 5 times quickly
   (subtitle gains "· developer"), then enable **Dev Tools (Agent Debugging)**.
2. `chrome://extensions` → reload Tulbelt, then reload the `*.tulip.co` tab.
3. Reproduce the scenario.
4. Open DevTools on the tulip tab → Console → **switch the context dropdown
   from "top" to "Tulbelt"** (the global lives in the extension's isolated
   world; the page context can't see it) → run `__tulbelt.copy()`.
5. If the console prints "clipboard blocked", run
   `copy(__tulbelt.lastExportJson)` — DevTools' built-in `copy` works without
   page focus, but only typed directly at the prompt.
6. Paste the JSON **into the chat or gitignored local notes only — never into
   tracked files**. The export redacts the hostname, but a tenant name that
   appears as bare text inside captured page content is not caught.

## Helper API (`window.__tulbelt`)

All helpers are inert (return `false`/`null`) unless developer mode **and** the
`dev-tools` toggle are both on. The buffer holds the last 500 entries, in
memory only — nothing is ever written to `chrome.storage`.

| Helper                    | What it does                                                                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `log(tag, ...args)`       | Push a sanitized entry. `__tulbelt?.log?.('my-feature', 'row applied', { id })`                                                                                                                                                                     |
| `snapshot(target, opts?)` | For a selector or element: `{ el, rect, attrs, styles, html }`. `opts.styles` picks computed-style props (default: display/position/visibility/overflow/z-index/width/height); `opts.htmlMax` caps outerHTML (default 4000).                        |
| `tree(target, depth = 3)` | Compact structural outline (`tag#id.class`, identical-sibling runs collapsed to `×N`). The fastest way to discover unfamiliar Tulip DOM. Returns the text and logs it.                                                                              |
| `watch(selector, opts?)`  | Record matching elements being added/removed (MutationObserver on the whole document). `opts.events: ['click', ...]` also records capture-phase events hitting the selector; `opts.attributes: true` records attribute changes with old/new values. |
| `unwatch(selector?)`      | Stop one watcher, or all when called without arguments.                                                                                                                                                                                             |
| `export()` / `copy()`     | Build the report, redact, stash in `lastExport` (object) and `lastExportJson` (string); `copy()` also writes to the clipboard.                                                                                                                      |
| `clear()`                 | Empty the buffer and reset the session clock.                                                                                                                                                                                                       |
| `enabled`                 | Read-only state — have the user check this first if a report comes back empty.                                                                                                                                                                      |

Typical probe (`toggles/dev-probe.js` body):

```js
(() => {
  window.__tulbelt?.log?.("probe", "loaded", { path: location.pathname });
  __tulbelt.watch('[data-testid*="trigger"]', { events: ["click"], attributes: true });
  setTimeout(() => __tulbelt.tree("main", 4), 3000);
})();
```

## Report format

```json
{
  "meta": {
    "exportedAt": "…",
    "version": "1.0.3",
    "url": "/w/DEFAULT/apps",
    "sessionMs": 12345,
    "entryCount": 42,
    "toggles": { "dark-mode": true, "…": false }
  },
  "entries": [
    {
      "t": 1042,
      "tag": "watch:[role=\"row\"]",
      "data": { "op": "added", "el": { "tag": "div", "class": "…" } }
    }
  ]
}
```

`t` is milliseconds since the toggle was enabled (or last `clear()`). Logged
values pass through a sanitizer: depth ≤ 8, ≤ 40 object keys, ≤ 50 array items,
strings capped at 2000 chars, DOM nodes collapsed to `{ tag, id, class }`,
functions/circulars/host objects replaced with markers.

## Redaction guarantee

`meta.url` is path + query only. The serialized report has every occurrence of
`location.hostname` replaced with `your-instance.tulip.co` before it reaches
the clipboard or `lastExport*` — covering hrefs inside captured HTML and logged
strings. Tenant names appearing as bare page text (e.g. a workspace label in a
snapshot) are **not** detected; hence the chat-or-gitignored-notes-only rule.

## MAIN-world bridge

MAIN-world scripts can't see the isolated-world global. While Dev Tools is on,
`devtools.js` listens for a `tulbelt:devlog` CustomEvent on `document`.
Temporary MAIN-world probe code logs with:

```js
document.dispatchEvent(
  new CustomEvent("tulbelt:devlog", {
    detail: JSON.stringify({ tag: "my-main-probe", data: { found: 3 } }),
  }),
);
```

The detail **must be a JSON string** — object details don't reliably cross the
world boundary. Entries arrive tagged `main:<tag>`. The existing
`__tulbeltFuzzy` / `__tulbeltAppCols` debug APIs remain the tools for those
specific features.

## Rules

- **Restore `toggles/dev-probe.js` to its stub before committing.**
  `git diff toggles/dev-probe.js` must be empty in any commit. Same for
  temporary `__tulbelt.log` calls that aren't worth keeping.
- Don't retrofit existing toggles onto the logger (surgical-changes rule).
- New or in-development toggles call it only via `window.__tulbelt?.log?.(...)`
  so they never depend on devtools.js being registered or enabled.
- `toggles/devtools.js` must stay **first** in the manifest's default
  content_scripts block (the shared global must exist before other scripts);
  `toggles/dev-probe.js` stays **last** (probes can inspect what toggles set up).
