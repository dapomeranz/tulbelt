# Contributing to Tulbelt

Thanks for helping out. Tulbelt is deliberately simple: **vanilla JavaScript,
no dependencies, no build step, no transpile.** Please keep it that way —
changes that add a toolchain or framework will be asked to justify themselves.

## Ground rules

- **One feature (or fix) per pull request.** Small, reviewable diffs.
- **Surgical changes.** Touch only what your feature needs. Don't reformat or
  "improve" adjacent code.
- **Every toggle must cleanly revert.** When a user switches a toggle off, the
  page must return to its original state without a reload. Look at any existing
  content script (`toggles/strip-tab-title-prefix.js` is a short example) — they all
  have an explicit restore path. This is a hard requirement, not a nicety.
- **Match the existing style.** 2-space indent, single quotes, semicolons, and
  a top-of-file comment explaining _why_ the approach works (not just what it
  does). Read a couple of existing files first.
- **No tenant-specific hostnames in git.** Do not commit real customer instance
  URLs (`<tenant>.tulip.co`). Use `*.tulip.co` in code and
  `example.tulip.co` / `your-instance.tulip.co` in prose. Keep local repro
  URLs in gitignored files (see `.gitignore`).

## Architecture in one minute

- **`features.js`** is the registry. Every toggle is one entry in the
  `FEATURES` array (`id`, `name`, `description`, `defaultEnabled`, and an
  optional network `rule`). `popup.js` renders the switch list from this
  automatically — you never edit the popup.
- **Content scripts** (`toggles/<feature>.js`) are plain IIFEs (not ES modules — they
  can't `import`). They read `chrome.storage.local`'s `toggles` object, apply
  on enable, revert on disable, and re-sync on `chrome.storage.onChanged`.
- **`background.js`** turns any feature with a `rule` into a dynamic
  `declarativeNetRequest` rule. Pure network features (redirects/blocks) need
  _no_ content script at all.

## Adding a toggle

### Case A — a DOM or behavior tweak (most features)

1. Add an entry to `FEATURES` in `features.js`:
   ```js
   {
     id: 'my-feature',          // stable, kebab-case, never reused
     name: 'Human readable name',
     description: 'One sentence the popup shows.',
     defaultEnabled: false,     // be conservative; most start off
     developerOnly: true,       // optional — hidden until dev mode (see below)
   },
   ```
2. Create `toggles/my-feature.js` following the existing pattern. Copy a small
   one (e.g. `toggles/hide-legacy.js`) and keep its shape:
   - wrap everything in `(() => { ... })()`
   - pull shared helpers from `window.__tulbeltLib` (defined in
     `toggles/lib.js`, loaded first in the default content_scripts array):
     `registerToggle` (storage sync + enable/disable lifecycle),
     `addedNodesObserver`, `ensureStyles`/`removeStyles`
   - `registerToggle(FEATURE_ID, { onEnable, onDisable })` — apply on enable,
     fully revert on disable
   - scripts in the `world: "MAIN"` or `all_frames` arrays can **not** use
     `__tulbeltLib` (different world/frames) — those keep the inline
     `syncFromStorage()` + `chrome.storage.onChanged` pattern (see
     `toggles/strip-tab-title-prefix.js` for the inline shape)
3. Register the file (as `toggles/my-feature.js`) in `manifest.json` under
   `content_scripts`. Add it to the
   default array, unless it needs the page's own JS context
   (`world: "MAIN"` array) or must run in subframes (`all_frames` array).

### Developer-only toggles

Set `developerOnly: true` on a `FEATURES` entry to hide it from the popup and
force it off at runtime unless the user unlocks **developer mode** (five quick
clicks on the popup title **Tulbelt**; subtitle shows `· developer`). Stored
toggle values are preserved so turning dev mode back on restores prior choices.

`getToggles()` enforces the off state for DNR-backed features. Content scripts
must also gate on `developerMode` in storage if they read `toggles` directly
(see `toggles/expression-editor-fuzzy.js`).

### Case B — a pure network rule (redirect/block, no DOM)

Only add the `rule` key to the `features.js` entry (see `table-default-sort`
for the shape). `background.js` syncs it automatically. No content script, no
manifest change.

### For non-trivial features

Add a short design note under `docs/` explaining the approach and any tricky
Tulip-DOM assumptions (see `docs/expression-editor-fuzzy-main.md`).

## Testing your change

Testing is manual only. Don't add automated tests, test files, or a test
runner — every change is verified by humans against a real Tulip instance,
and mocked DOM/API tests wouldn't reflect the real pages anyway.

You need access to a Tulip instance to test against real pages.

1. Load the extension unpacked (see README).
2. After editing: click **reload** on the extension card in
   `chrome://extensions`. For content-script changes also reload the
   `*.tulip.co` tab.
3. In the popup, toggle your feature **on and then off**, and confirm the page
   fully returns to its original state.

Quick local sanity checks (no dependencies needed):

```sh
node --check toggles/my-feature.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
node --check features.js
```

## Opening the pull request

Describe **what** the toggle does and **why**. For UI changes, include
before/after screenshots or a short clip. Confirm in the description that the
toggle reverts cleanly when disabled. If the change is user-facing, the popup
updates itself from `features.js`, so no doc edit is required — but feel free
to bump the `version` in `manifest.json` if you think a release is warranted
(maintainer will decide).

By contributing, you agree your contributions are licensed under the project's
[MIT License](./LICENSE).
