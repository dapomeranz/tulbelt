# Expression editor fuzzy search (`expression-editor-fuzzy-main.js`)



This document explains how the main-world half of Tulbelt’s expression-editor fuzzy search works. The implementation lives in `toggles/expression-editor-fuzzy-main.js`; the isolated-world toggle bridge is in `toggles/expression-editor-fuzzy.js`.



## Purpose



Tulip’s expression autocomplete is React-driven and **context-filtered** (fields vs functions/operators depend on what you’ve typed). This feature replaces the visible suggestion list with a custom overlay that searches the **full** suggestion catalog (size varies by Tulip instance — fields, apps, and functions in the workspace) while still inserting choices through Tulip’s native selection path.



## Two-world architecture



| Piece | World | Role |

|-------|--------|------|

| `expression-editor-fuzzy.js` | Isolated | Reads `chrome.storage`, sets `<html data-tulbelt-fuzzy-enabled="true\|false">` |

| `expression-editor-fuzzy-main.js` | **MAIN** (see `manifest.json`) | Watches that attribute; all DOM/React work happens here |



The main-world script cannot use `chrome.*` APIs. Enable/disable is signaled only via the `data-tulbelt-fuzzy-enabled` attribute on `<html>`.



## High-level flow



```

html[data-tulbelt-fuzzy-enabled="true"]

  → MutationObserver on document

  → Detect popper + ReactVirtualized list + expression editor

  → attachToPopper

  → Read master list from React fiber

  → Hide native list, show custom overlay

  → On editor mutations: render (filter + draw rows)

  → Click / Enter → selectItem → invokeNativeListRowSelect (or onSelection fallback)

```



## Activation lifecycle



| Event | Action |

|-------|--------|

| `data-tulbelt-fuzzy-enabled="true"` | Inject styles, install capture-phase key handler, start document observer, scan and attach poppers |

| Popper appears (list + editor) | `attachToPopper` → overlay + editor `MutationObserver` |

| User types | `render` → re-read live arrays, filter, redraw overlay |

| User picks row / Enter | `selectItem` → native row handler, or `onSelection` for fuzzy-only picks |

| Feature off | Detach all, remove styles; stop observer unless observe mode is on |



## Finding and attaching to the popup



When enabled:



1. **`ensureStyles`** — CSS for overlay rows and hiding the native React list.

2. **`installGlobalKeyHandler`** — capture-phase `window` keydown (runs before Tulip’s editor handlers). Arrow keys / Enter navigate the overlay; **Ctrl+Enter** (Cmd+Enter on Mac) clicks `[data-testid="expression-editor-save-button"]`. The Save button gets an `aria-label` / `title` hint when a popper attaches.

3. **`startObserver`** — `MutationObserver` on `document.documentElement` for new poppers/lists.

4. **`requestScan` → `scanAll`** — coalesced per animation frame; finds `.ReactVirtualized__List` inside `[data-testid="popper"]` that also contains `[data-testid="expression-editor-input"]`.



### `attachToPopper`



- **`fiberOfNearestHost(list)`** — walks up to 6 ancestors to find a React fiber.

- **`findLists(fiber)`** — collects options-shaped arrays from fiber props/hooks.

- **`master`** — largest options array (Tulip’s full suggestion catalog for this instance; not a fixed size).

- **`master` only** — the overlay filters the largest options array (`props.suggestions` in practice). Smaller props like `contextNames` are not suggestion lists.

- **`findSelectHandler`** — locates `onSelection` (sanity gate at attach; stored as `state.onSelect` for fuzzy-only fallback).

- **`buildOverlay`** — hides the real list and appends the custom overlay.



Per-popper state is stored in `popperState` (`WeakMap`).



## Filtering (“fuzzy”)



Case-insensitive substring search on labels, capped at **200** results (`MAX_RESULTS`). Master-list order is preserved.



- Bypasses Tulip’s context gating (e.g. `floor` → `Floor()` from anywhere).

- Leading `@` on the query restricts to field labels.

- **`HIDDEN_LABEL_PREFIXES`** drops noisy categories.



The filter **query** comes from `getCurrentRange`. The same token span drives fuzzy-only `onSelection` indexes.



## Caret and token range (`getCurrentRange`)



Tulip’s editor mirrors text in `.content` (spans with `data-index`) and `.cursorContainer` (`.cursor` spans).



1. **`caretOffsetIn`** — maps visible cursor to offset.

2. Walk backward/forward to hard separators `[+\-*/(),;"'=!<>%&|^~]` (whitespace and `.` are not separators).

3. Clamp to active field span via `spanAtCaret`.

4. **Trailing edge of a committed field chip** — if the caret sits on the chip’s end boundary (not inside it), return an empty query and zero-width span so a second **Enter** (e.g. after finishing an `OBJECT({…})` value) is left to Tulip instead of re-selecting the chip and splicing the formula.



## Selecting an item (`selectItem`)



**Do not compute splice indexes by walking `controller.value`.** Tulip serializes field chips as `\u001f`-delimited blobs; token-walking lands inside the first chip.



1. **Focus the editor.**

2. **`invokeNativeListRowSelect`** / **`invokeNativeRowSelectFromFiber`** — call the matching row’s React `onClick` / `onMouseDown` when that row is mounted in the hidden list (DOM match first, then fiber walk).

3. **Fuzzy-only fallback** — **`state.onSelect`** with indexes from frozen token range (`pendingSelection` on overlay click, else fresh `getCurrentRange()` on Enter) when the token is **after** all `.field` chips. Do **not** splice when the token is **inside** a committed field chip. Do **not** focus the editor on overlay mousedown.



## Keyboard navigation



Capture-phase `window` listener for `ArrowUp`, `ArrowDown`, and `Enter` when the target is inside the attached editor. **Enter** is not intercepted when `getCurrentRange().query` is empty (caret after a committed chip with nothing left to filter).



## Debugging (agents)



All helpers live on `window.__tulbeltFuzzy` in the **page** console (main world), not the extension popup console.



### A/B comparison (same commands)



```js
// 1) Native Tulip — turn fuzzy OFF in Tulbelt, open expression editor
__tulbeltFuzzy.capture()       // or capture('baseline')
// … type + pick from Tulip’s native list (not the overlay) …
__tulbeltFuzzy.copyLog()       // saves lastBaselineExport / lastBaselineJson

// 2) Enhanced — turn fuzzy ON, same editor scenario
__tulbeltFuzzy.clearLog()
__tulbeltFuzzy.capture()       // or capture('enhanced')
// … same steps using the overlay / Enter …
__tulbeltFuzzy.copyLog()       // saves lastEnhancedExport / lastEnhancedJson

// 3) Both runs in one paste (after two copyLog() calls)
__tulbeltFuzzy.copyComparison()

__tulbeltFuzzy.capture(false)  // stop recording
```



`capture()` with no argument picks the phase from the fuzzy toggle: **off → baseline**, **on → enhanced**. Force a phase with `capture('baseline')` or `capture('enhanced')`. Call `capture()` again (or `capture(false)`) to stop.



Exported JSON includes `phase: "baseline" | "enhanced"`. During capture, log lines use shared tags:

| Tag | When |
|-----|------|
| `capture:edit` / `capture:attach` | Each coalesced editor mutation (baseline + enhanced while observing) |
| `capture:keydown` / `capture:keydown→after` | Enter, Tab, or arrows in the editor (native list picks without click) |
| `capture:click` / `capture:click→after` | Native virtualized row click |
| `capture:onSelection` | Wrapped `onSelection` handler |
| `capture:render` | Enhanced overlay redraw (filtered count + pending indexes) |
| `capture:pick→after:…` | Enhanced pick (`native`, `type-field`, `onSelection`) |

Each `capture:edit` entry includes the same fields the plugin uses: `range.caret`, `pending` (token span + controller cursor), `controller` (DOM range, content spans, selection), and `listDom` (`nativeRowCount`, etc.). `indexPreview` is logged on enhanced picks / `capture:render` only (misleading on multi-chip edits).



| Method | Purpose |

|--------|---------|

| `capture(phase?)` | Start/stop session recording (`false` / toggle off; `'baseline'` / `'enhanced'` / auto) |

| `exportLog()` / `copyLog()` | Full session (`entries` + `state` + `phase`). Use `copy(__tulbeltFuzzy.lastExportJson)` — do not `JSON.stringify(lastExport)`. |

| `exportComparison()` / `copyComparison()` | `{ baseline, enhanced }` from the last two `copyLog()` runs |

| `lastBaselineJson` / `lastEnhancedJson` | Last export per phase |

| `clearLog()` | Clear session buffer (between runs) |

| `report()` / `snapshot()` | Current state only (no history) |

| `captureActive()` / `capturePhase()` | Is capture running? which phase? |

| `debug(level?)` | Manual log level (`off` \| `select` \| `observe` \| `all`) — rarely needed during `capture()` |

| `range()`, `selection()`, `state()`, `listDom()`, `findLists()`, `dumpArrays()`, `dump()`, `findSelect()` | Inspection |

| `observe(bool?)` | Passive shadow logger without capture tagging |

| `baseline()` / `enhanced()` | Deprecated aliases for `capture('baseline')` / `capture('enhanced')` |



## Key constants



| Symbol | Value |

|--------|--------|

| `POPPER_SEL` | `[data-testid="popper"]` |

| `EDITOR_SEL` | `[data-testid="expression-editor-input"]` |
| `SAVE_BTN_SEL` | `[data-testid="expression-editor-save-button"]` |

| `LIST_SEL` | `.ReactVirtualized__List` |

| `MAX_RESULTS` | 200 |



## Related files



- `toggles/expression-editor-fuzzy-main.js` — main-world implementation

- `toggles/expression-editor-fuzzy.js` — isolated-world storage → attribute bridge

- `manifest.json` — `world: "MAIN"` content script entry



## One-line summary



Replaces Tulip’s virtualized suggestion list with a fuzzy-filtered overlay over the full catalog, and inserts picks by calling each native list row’s React click handler (or `onSelection` when the row isn’t in Tulip’s DOM).


