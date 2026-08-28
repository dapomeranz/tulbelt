# App & Table history search (`history-search.js`)

Toggle `history-search` ("App & Table History (⌘K / Ctrl+K)"). One isolated-world
content script that logs the apps and tables you open and adds a **⌘K/Ctrl+K**
search palette to jump back to any of them. Ships on by default.

## Two concerns

- **Recorder** — watches SPA navigations and records the current page when it is
  an app editor or a table.
- **Palette** — a shadow-DOM overlay opened on ⌘K/Ctrl+K that substring-filters the
  recorded history (by name + folder) and navigates to the chosen entry.

## Storage

Two keys in `chrome.storage.local`:

- `toggles` — the on/off flag (shared registry key; read only).
- `tulbelt:history` — **its own key**, an MRU array of
  `{ kind, id, name, folder, root, url, ts }`, capped at 100 entries. Kept
  separate from `toggles` exactly like `auto-snapshot.js`'s `autoSnapshotState`.

Writes re-read before writing so two tabs don't clobber each other's history.

## Page detection & names

- **Table**: `…/table/<id>` → `kind: 'table'`, `id` = table id.
- **App editor**: `…/apps/<id>/versions/…` → `kind: 'app'`, `id` = **app id**
  (deduped across versions). Same URL shape as `auto-snapshot.js`.
- **Connector function**: `…/connector/<connectorId>/function/<functionId>` →
  `kind: 'connector'`, `id` = function id. The breadcrumb's
  `subheader-breadcrumb` holds the connector name (e.g. "Tulip Tables API"),
  which is captured as the `folder`.

The human-readable fields come from the breadcrumb DOM:
`[data-testid="subheader-title"] h1` (name),
`a[data-testid="subheader-breadcrumb"]` joined by `/` (folder path), and
`[data-testid="subheader-root-breadcrumb"]` ("Apps" / "Tables").

### Why "wait for the title to settle"

The breadcrumb/title renders asynchronously after an SPA navigation. The
recorder runs on a debounced `MutationObserver` (on `document.body`) plus a light
`location.href` poll, and **only records once the title `h1` has non-empty
text**. So the first ticks after a navigation no-op until the name is available;
dedupe by `kind+id` (move-to-front) keeps that from creating duplicates.

### Dedupe by app id

Apps are keyed by app id, not version, so opening the same app at different
steps/versions updates one entry instead of spawning many. The stored `url`
keeps the **most recently seen** full URL for that key (the recorder uses
`location.href`), so re-opening lands on the latest version you visited.

## Navbar button

When enabled, a magnifier icon is injected to the **left** of the global header
actions (before `#factory-recent-activity` — recent activity, help, settings).
It clones the neighboring wrapper/button structure so Tulip's styled-component
classes and tooltip hooks match. Click toggles the same palette as **⌘K/Ctrl+K**.
The button is removed on disable (tagged with `data-tulbelt-history-nav`).

## Palette behavior

- **⌘K** (Ctrl+K on Windows/Linux) toggles the overlay (capture-phase `keydown`
  on `window`, `preventDefault` + `stopPropagation`). The modifier is chosen by
  `isMacLike()` — `metaKey` on Mac, `ctrlKey` elsewhere — and the opposite
  modifier is rejected so ⌘K and Ctrl+K don't both fire on Mac. **Esc** /
  backdrop click closes.
- Substring filter over `name + folder`, results ordered by recency.
- Arrow keys move the selection; **Enter** opens in the current tab,
  **Ctrl/Cmd+Enter** opens a new tab. Click opens (same tab); middle-click or
  Ctrl/Cmd-click opens a new tab.
- The search field is a **light-DOM** `<input slot="search">` slotted into the
  shadow panel. Slotted nodes are not retargeted to the host, so Tulip's
  document-level single-key hotkeys (e.g. **B**, **T** on the apps page) see a
  real focused input and skip. The input also `stopPropagation`s on `keydown`
  (bubble phase), and the backdrop swallows `keydown`/`keypress`/`keyup` for
  anything else that still escapes.

### Palette UI

White panel with a flush search header (magnifier icon + borderless field on a
light gray strip), blue link-style row titles, light row dividers, and pale-blue
keyboard selection (`#e8f4fd`). Folder path and relative time sit on a
secondary gray line under each name.

## Revert (toggle off)

`syncFromStorage()` removes the keydown listener, disconnects the observers,
clears the poll interval, removes the navbar search button, and removes the
shadow-DOM host — the hotkey returns to its native browser behavior with no page
reload. Recorded history is **left in storage** (it's data, not a page
mutation), so re-enabling restores the list.

## Known caveats

- **Hotkey override** only fires when the page has focus. If focus is already in
  the browser address bar, the browser keeps it — inherent to content-script key
  interception.
- **Dark mode interaction**: the `dark-mode` toggle inverts the whole document
  via CSS filter, which also inverts this overlay. Out of scope for v1.
- **Stale version URLs**: a stored app URL points at the last-seen
  `/versions/<v>`; a since-deleted version could 404.
