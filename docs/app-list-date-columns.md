# App list Created / Last Completed columns (`app-list-date-columns`)

Toggle `app-list-date-columns` ("App List: Created & Completed Columns"). On
app/folder list pages (e.g. `/w/<ws>/apps/folders/<folderId>`) it adds two
columns — **Created** and **Last Completed** — after the existing **Last
Modified** column. Ships on by default.

## Why two halves (MAIN + isolated world)

The created / last-completed timestamps are **not in the DOM**. The list table
only renders Last Modified. The dates live only in the JSON the page fetches
from `/api/apps/v1/.../apps`, whose `items[]` carry `created.at` and
`lastCompleted.at` keyed by app `id`.

An isolated-world content script can't see the page's own `fetch`/XHR responses,
so capture must happen in `world: "MAIN"`. We reuse the split pattern from
`expression-editor-fuzzy`:

- **`app-list-date-columns.js`** (isolated) — reads the `toggles` flag and
  mirrors it to `<html data-tulbelt-app-dates-enabled="true|false">`.
- **`app-list-date-columns-main.js`** (MAIN, `run_at: document_start`) — patches
  `fetch`/XHR to capture the data, watches that attribute, and injects/reverts
  the columns. MAIN world has no `chrome.*`, hence the attribute bridge.

`document_start` matters: the capture wrapper must be installed before the page
issues the apps request, so cold page loads populate.

## Network capture (always on, invisible)

The wrapper is installed unconditionally — independent of the toggle — because
the toggle state isn't known at `document_start` and capturing is a
side-effect-free read. It clones each response whose path ends in `/apps`
(`isAppsListUrl`), parses it, and merges `{ id -> { createdAt, lastCompletedAt }
}` into a Map. The original `Response`/XHR is returned untouched.

The match covers every list-of-apps endpoint, which differ by view:

- `/api/apps/v1/w/<n>/apps` — root apps list
- `/api/apps/v1/w/<n>/folders/<id>/apps` — a folder's contents
- `/api/users/v1/w/<n>/users/<id>/recents/apps` — the **Recents** view
- `/api/users/v1/w/<n>/users/<id>/favorites/apps` — the **Favorites** view

`ingest` is tolerant of the response shape (a bare array, `{ items: [...] }`, or
`{ apps: [...] }`) since these endpoints don't all agree.

Keying by app `id` (not by URL) means every app row whose id was seen gets
enriched, regardless of which view loaded it. Folder rows (links containing
`/apps/folders/`) have no app id and show an em dash (`—`); so do apps never
completed.

Leaving a transparent pass-through wrapper installed when the toggle is off is
**not** a page mutation — nothing visible persists (no columns, no observer), so
the revert invariant holds. This mirrors the fuzzy MAIN script always being
loaded.

## Backfill (when capture missed the request)

If the page's apps request completed **before** our wrapper was installed — most
commonly when the extension is reloaded into an already-open tab (content scripts
inject at that point, long after `document_start`) — the response is gone and the
columns would show em dashes. A backfill re-fetches it ourselves:

- `findAppsUrl()` reads the exact URL the page used from
  `performance.getEntriesByType('resource')` (same-origin entries expose the full
  query string, incl. the numeric `w/<n>` workspace and `userId`), preferring the
  entry for the folder currently in the address bar.
- The apps API needs an `Authorization: Basic <token>` header (a token the SPA
  holds — **not** replayable from cookies alone), so the capture wrapper also
  lifts that header from any intercepted request (fetch init/`Headers`, or XHR
  `setRequestHeader`) into `knownAuth`, and the backfill replays it with
  `credentials: 'include'`.
- `maybeBackfill()` runs from `applyAll()` whenever an app row is still missing
  its dates; each URL is attempted once (`backfillAttempted`), with one retry
  allowed the first time an auth token is learned.

In practice: a fresh tab load is covered by `document_start` capture; an
extension reload is covered by backfill (or simply by navigating to another
folder, which the live wrapper then intercepts directly).

## Column injection

When enabled, a `MutationObserver` on `document.body` drives `applyAll()`
(debounced via `requestAnimationFrame`). For each `[role="row"][widths]`:

- Two cells are inserted **before the trailing two cells** (the 44px edit/actions
  button columns), so those button cells stay structurally last — which keeps the
  `reorder-row-buttons` toggle's `:last-child` / `:nth-last-child(2)` selectors
  valid.
- Cells are built by **cloning** the Last Modified cell (header clones the
  `[data-testid="header-lastModified.at"]` columnheader) and stripping its
  buttons/svgs/links, so the hashed `sc-*` styling is inherited rather than
  hard-coded.
- The row's inline `grid-template-columns` is widened: two `160px` tracks are
  inserted before the trailing two button tracks, computed from the `widths`
  attribute.

Each row is tagged `data-tulbelt-appcol-src = "<widths>|<reorderActive>"`. Apply
is idempotent: if the cells exist, the signature matches, and the inline grid
already equals the desired value, body text is just refreshed (data may have
arrived after the row rendered) and nothing else is rewritten.

## Interaction with `reorder-row-buttons`

That toggle visually moves the last two cells next to the name using CSS `order`
and rewrites `grid-template-columns` from `widths` (a permutation that pulls the
last two tracks into slots 2–3). Coexistence:

- We replicate the **same** permutation on our widened 7-track list when the row
  has `data-tulbelt-reorder="true"`, so our tracks line up with reorder's
  `order`-driven visual order.
- Reorder's observer reacts only to **row** additions and does **not** watch
  attributes, so our cell insertions and `style` writes never wake it (no
  ping-pong). To stay correct regardless of which observer fires first on a
  re-render, our observer also watches row attributes `widths`, `style`, and
  `data-tulbelt-reorder` and re-applies idempotently. When reorder writes its
  narrower grid we rewrite the wider one; reorder doesn't react, so it converges
  in one extra tick.

## Revert (toggle off)

`disable()` disconnects the observer, removes every `[data-tulbelt-app-col]` cell,
and restores each touched row's `grid-template-columns` to the non-our value
(recomputed from `widths`, replaying reorder's permutation when active — we don't
just `removeProperty`, since React's original was inline `!important` and would
otherwise vanish until the next render). The capture wrapper and Map stay (ambient
infrastructure, invisible). No page reload.

## Debug aid

From the page console:

- `__tulbeltAppCols.dump()` — captured `{ id, createdAt, lastCompletedAt }` rows.
- `__tulbeltAppCols.state()` — `{ enabled, hasAuth, captured, appsUrl, attempted }`.
- `__tulbeltAppCols.debug = true` — log capture + backfill activity.
- `__tulbeltAppCols.backfill()` — force a re-fetch now (clears the attempted set).

## Known caveats

- **Relative time**: matches the native Last Modified wording style ("8 days
  ago"); the exact date is in each cell's `title` tooltip.
- **Dark mode**: the `dark-mode` toggle inverts the whole document via CSS
  filter; injected cells inherit that like the rest of the table.
- **React reconciliation**: cells are mid-inserted into React-managed rows and
  re-inserted on mutation if React replaces them. If a future Tulip build fights
  this, the fallback is append-at-end + CSS `order`.
