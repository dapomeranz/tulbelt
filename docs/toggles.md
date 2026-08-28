# Toggle reference

Every toggle Tulbelt ships, what it changes, and its out-of-the-box state.

The **authoritative** list and exact behavior live in [`features.js`](../features.js)
and are rendered live in the popup. This page is a human-readable companion —
if the two ever disagree, `features.js` wins.

"Default" is the state a fresh install starts in; you can flip any toggle from
the popup at any time, and every toggle cleanly reverts when switched off.

Toggles are listed alphabetically in one ungrouped run. The popup groups them
instead: the opt-in toggles first, then an "On by default" section holding the
ones that ship on, each run alphabetical by `name`. (The headings below are this
page's own titles, so its order and the popup's are close but not identical.)

### App list Created/Completed columns — `app-list-date-columns` · **default: on**

On app/folder list pages, adds **Created** and **Last Completed** columns after
**Last Modified**. Those dates aren't in the DOM — they live in the JSON the page
fetches from `/api/apps/v1/.../apps` — so a `world: "MAIN"` half (`run_at:
document_start`) transparently patches `fetch`/XHR to capture `{ id ->
created.at, lastCompleted.at }`, while an isolated half bridges the toggle state
via `<html data-tulbelt-app-dates-enabled>`. Two cells are cloned from the Last
Modified cell and inserted before the trailing button columns, and the row's
`grid-template-columns` is widened to match (replaying `reorder-row-buttons`'s
permutation when that toggle is also on, so both stay aligned). Folder rows and
never-completed apps show an em dash. Reverts to the original grid on disable; the
invisible capture wrapper stays. See `docs/app-list-date-columns.md`.

### Auto-snapshot every 15 active min — `auto-snapshot` · **default: off**

In the app editor, tracks active editing time per app and automatically creates
a snapshot after each 15 minutes of activity. Stateful — it persists per-app
activity time across navigation.

### Collapse table rows — `collapse-tables-tile` · **default: off**

On app version editor pages only (`/w/…/apps/…/versions/…` or
`/apps/…/versions/…`), turns each row of
the Tables tile in the right context pane into a tree-view item. A caret pinned
to the right edge of each row toggles its collapsed state; when collapsed, the
row's Query / Record Placeholder buttons, aggregations, and linked record
placeholders are hidden, leaving just the icon, table name, and a two-line
"· N placeholders" / "· M aggregations" summary visible (lines with a zero
count are omitted). A "Collapse all" / "Expand all" toggle below the Add
Table row collapses or expands every table at once. The summary is hidden when
expanded, and the table-name button keeps its original menu-open click. Each
table starts collapsed; state lives in DOM attributes only, so a fresh
navigation collapses everything again.

### Compact app editor header — `compact-app-editor-header` · **default: off**

In the app editor: hides the workspace name beside breadcrumbs, hides leading
icons on palette buttons (Add, Icons, …, Forward/Back), and tightens vertical
padding on the subheader and palette rows. (Supersedes the older
`hide-app-editor-palette-icons` and `hide-subheader-workspace-label` toggles,
which migrate automatically.)

### Copy/Cut in widget menu — `context-menu-copy-cut` · **default: on**

In the app editor canvas widget context menu (Delete / Move To Front / Back),
adds Copy (Ctrl+C) and Cut (Ctrl+X) rows that synthesize those keyboard
shortcuts when clicked.

### Dark mode — `dark-mode` · **default: off**

Applies a dark color scheme to tulip.co via filter-inversion (invert, contrast,
brightness on the document; restored regions use the exact inverse so previews,
canvas, images, and video stay hue-faithful). Targeted tweaks for specific
surfaces are layered on top.

### Data queries — `data-queries` · **default: off**

Adds a **Data Queries** tab to the Tulbelt page (account dropdown → **Tulbelt**;
see [the shared page shell](#the-tulbelt-page-shell) below). Paste a table id —
`Sb28KTCAWbt6PLm5f` — or a whole table URL and hit **Load table** to fetch its
columns, then build a query against them and save it under a name.

**Two faces: use and edit.** Opening a saved query shows its _use_ face — the
name with a **✎** pencil beside it, a one-line summary (`Orders · 3 filters ·
sorted by Created ↓ · 5 of 12 columns`), and its search boxes; **Export CSV**
sits in the pager above the grid, beside **‹ Prev**, in both faces. Nothing in
the use face changes the query; the common errand is grabbing a saved query and
reading rows.
The pencil swaps in the _builder_ — accent bar, "Editing query" — with the name,
the table picker, every filter and sort row, the column chooser, **Save** and
**Cancel**. Save keeps the changes and returns to the use face; Cancel re-opens
the saved version (text in the search boxes survives). **+ New query** and a
query that hasn't been saved yet are always in the builder — there is nothing to
use until it has a name.

**The builder.** Filter rows are _field · operator · value_, matched on **all**
or **any**, plus **Default sort** rows — the order the query opens in, and what
the grid goes back to. The operators offered for a column
are narrowed by its `dataType` — a text column gets `contains`/`startsWith`, a
number or timestamp gets the comparisons, and an unrecognised type gets all
sixteen rather than hiding the one you needed. `is any of` / `is none of` take a
comma-separated list and are sent as a JSON array. `is blank` / `is not blank`
take no value at all. Rows with no field chosen are ignored, so a half-filled
row never blocks a run.

**Columns.** The chooser under the sort rows — **▸ All 12 columns** — opens a
popover with **Select all**, **Deselect all**, and a checkbox per column (the
table's own fields plus `id` and Tulip's `_createdAt` / `_updatedAt` /
`_sequenceNumber`). The grid narrows as you tick, and **Export CSV** carries
exactly the ticked columns, in the table's own order, whether or not a page
happens to have values for them. The selection is saved with the query as
`columns: string[]`; every column ticked normalises to `columns: null`, so a
query saved with everything shown keeps showing fields added to the table later.
It is client-side only — the records call has no projection parameter, so every
field still comes down the wire. Switching the query to a different table drops
the selection; deselecting everything leaves the grid empty with a note rather
than quietly showing all.

**Archived tables and columns never appear** — not in the picker (the recents
included), the filter fields, the sort fields, the column chooser, the grid, or
the CSV. Tulip archives by soft delete (`deletedAt` on a table, `hidden` on a
column), and `isArchived()` in `data-queries.js` also accepts `deleted`,
`archived`, `isArchived`, `archivedAt` and `status: "archived"` since the
endpoints are private and the shape is second-hand. The grid rule matters
because records still carry values for archived fields: the metadata says the
column is gone, and the metadata wins. `docs/probes/archived-flags-probe.js`
prints which flags a tenant actually sends.

**Sorting the grid.** Click a column header to sort by it, ascending; click it
again to flip. Every header sorts, including `id` and Tulip's own fields. This
is not the browser reordering a page: the request goes back out with the same
filters and search terms and the clicked column as `sortOptions`, from page
one, so it is the whole answer sorted — and **‹ Prev / Next ›** and **Export
CSV** follow it. It is a _view_ sort, not part of the query: nothing is saved,
the builder's **Default sort** is untouched, and a note above the grid
(`Sorted by Qty ↑ · back to the default sort`) is the way back. Opening a
different query, switching the table, or editing the default sort all drop it.
The arrow on a header shows whichever sort is in force — the default sort's
first row when nothing has been clicked.

**There is no Run button — the query runs itself.** Picking a table, changing a
filter's field or operator, adding or removing a filter or sort, switching
all/any, clicking a column header, opening a saved query, or coming back to the
tab all fetch the answer;
typing into a filter value fetches ~450ms after you stop. Runs supersede rather
than queue, so only the last one's answer reaches the grid, and the caret stays
where it was when a re-render lands under it. A row that doesn't compile yet
(`"is" needs a value.`) doesn't run at all: the reason shows as a grey note
in the builder's action row and the last good answer stays on screen until the
row is finished.

**The page size is fixed at 100** and is not adjustable. There was a Limit box;
it was a foot-gun — a small limit silently truncates the answer, and nothing is
bought by asking for less. A query hand-written with a larger `limit` still gets
what it asked for: 100 is a floor, not a ceiling. **‹ Prev / Next ›** above the
grid walk `offset` a page at a time (`Records 101–200`, `Page 2`); the grid stays
on screen while the next page is fetched rather than blinking out. There is no
page count to show — a records call returns a page and no total — so **Next** is
offered whenever the current page came back full, and any change to the query
sends you back to page 1.

**Export CSV** is how you get the whole answer out. It re-runs the _same_ query
you built and walks it page by page — `offset` 0, 100, 200, … — until a page
comes back empty, then downloads the union of every page as a CSV. Columns are
the union across all rows fetched (records omit fields they have no value for),
values are RFC 4180-escaped, objects are written as JSON, and the file is CRLF
with a UTF-8 BOM so Excel opens it without mangling. Progress shows the running
count and a **Cancel** that takes effect between pages. A cap of 1000 pages
(100k records) stops a runaway; hitting it says so rather than pretending the
file is complete. Every page is a separate request on the session's own
credentials, exactly like the grid's own.

**The grid** orders columns the way the table itself does — the field sequence
the metadata call hands back, so the columns read as they do on Tulip's own
table page — with `id` first, any field the metadata didn't mention after the
ones it did, and Tulip's own record fields (`Seq`, `Created`, `Updated`) last.
It scrolls inside itself, header row pinned, and `overscroll-behavior: none`
keeps the scroll to the grid: no rubber-band past its own edge, and no swipe
that runs off the end of it scrolling — or history-navigating — what's behind.
The page shell's `.tbp-content` carries the same rule for the same reason: the
panel covers the app, so its scroll has nowhere sensible to chain to.

**Saved queries** are listed down the left: click one to load and run it, `⧉` to
copy it as JSON for sharing, `×` to delete (with a confirm step). Saving
requires a name; saving again under the same name updates in place rather than
duplicating. They live in the tenant's
`localStorage` under `tulbelt-data-queries` — per browser, per Tulip instance,
never shared. That key previously held a bare table id; that value is migrated
to `lastTableId` on first read.

**Import / export** works the way [option sets](#option-sets-builder--option-sets-builder--default-on)
do — JSON on the clipboard rather than a file, because a query is small and
pasting into chat is how these actually travel. `⧉` on a saved query copies a
`{ "tulbelt": "data-queries", version: 1, queries: [ … ] }` payload with the
local id and timestamps stripped; **Import** takes a pasted payload, mints fresh
ids, and adds the queries alongside your existing ones — a name already in use
gets a numeric suffix rather than overwriting. `queries` is an array so several
can travel together even though the UI exports one at a time, a bare `query` is
accepted too, and a `version` from a newer Tulbelt still imports as long as the
shape checks pass. A filter naming an operator this build doesn't know is
rejected with a reason, not silently dropped.

**Replicated types.** `toggles/data-queries-model.js` holds the whole query
vocabulary — the 16-member `FilterFunctionType`, `Filter`, `SortOption`,
`FilterAggregator`, and the `buildQueryString` serialisation rules — replicated
from `@locus-ot/tulip-api` (v1.0.39) rather than imported: that package is
proprietary, this extension is MIT, and MV3 content scripts have no bundler to
import through. The replication is verified by differential test against the
real package — every operator's output and the assembled query string are
byte-identical to the library's. A consequence worth keeping: **a saved query is
a valid `getRecords()` params object**, so anything built here can be pasted
straight into a Node script using the actual library. If that library's filter
contract changes, the model file is the single place to update; the version
above is the pin.

The model is pure (no DOM), so it can be exercised on its own; `data-queries.js`
is the UI over it and owns no query semantics.

**The calls** are the ones Tulip's own table page makes:

```
GET /api/v3/w/<wsId>/tables/<tableId>/records?filters=…&filterAggregator=…&sortOptions=…&limit=…&offset=0
GET /api/v3/w/<wsId>/tables/<tableId>          (columns + labels; failure is non-fatal)
GET /api/v3/w/<wsId>/tables                    (the picker's list, unpaged — it takes no query string; failure is non-fatal)
```

**Search inputs.** A filter value containing `[Name]` becomes a runtime input:
each distinct name renders a labelled box above the grid — in the use panel,
where they are the only controls, and under the builder while editing so a
placeholder can be tried as it is typed. Typing debounces at 450ms and re-runs,
the same path a filter-value edit takes; Enter skips the wait.

**A blank box drops its filter** rather than matching on an empty string, so an
untouched query returns the whole table and each box narrows it as it is filled.
That rule lives in `resolveValue()` in the model, which returns `null` for a
value whose placeholders are still empty; `compileFilters()` skips those rows the
same way it skips a row with no field. A value with no brackets parses to zero
inputs and compiles byte-identically to before, so existing saved queries are
untouched.

Placeholders can be embedded (`ACME-[Suffix]`) and one name can feed several
filters. Operators taking no value (`is blank`) can't hold one. There is
deliberately no escape for a literal bracket — a table value containing brackets
that someone also wants to search on is rare enough to leave the rule
unqualified.

What gets typed lives on `state` for the life of the tab and is never persisted:
a saved query stores the *template*, so opening it gives the boxes back empty,
and opening a different query clears them. One consequence worth knowing:
`toSaved` stores the compiled `filters` array as well as the templates in `rows`,
because a saved query is guaranteed to be a valid `getRecords()` params object.
A template has no valid compiled form, so `filters` is compiled against whatever
was typed at save time with blanks dropped, while `rows` keeps the templates.

**Picking a table.** The field is a combobox: type to filter the workspace's
tables by name or id, arrow keys and Enter to choose. Tables you opened recently
head the list, read straight from `history-search.js`'s
`chrome.storage.local["tulbelt:history"]` — the two toggles share an isolated
world, so this costs no request and works even when the list call doesn't. Both
sources are optional. The input still holds the table _id_ and still accepts a
pasted id or table URL, exactly as it did before the picker, so a `/tables`
refused to the session's borrowed credential degrades to recents-plus-paste with
a note in the dropdown's footer rather than an error. `docs/probes/table-list-probe.js`
diagnoses such a refusal; `docs/data-queries-table-picker.md` covers the
endpoint and the fallbacks.

**Auth.** No API key field, and nothing is stored. `toggles/tulbelt-session-main.js`
runs in the MAIN world at `document_start` and patches `fetch`/`XHR` to capture
the `Authorization: Basic …` header Tulip's own frontend sends, parking it (with
the numeric workspace id, which the browser URL doesn't carry — it shows a slug
like `/w/DEFAULT/`) on `<html>` as `data-tulbelt-auth` / `data-tulbelt-wsid` for
the isolated world to read. Requests go out same-origin with
`credentials: "include"` as well, so a rejected header is retried once on cookies
alone before giving up; if nothing has been captured yet — a cold load straight
onto the fake URL, or the extension reloaded into an already-open tab — the error
says to open a Tulip page in the tab and come back. Everything is scoped to the
signed-in session, so the page can only show what the account can already see.

**Results.** The union of keys across the page (records omit fields they have no
value for), ordered ID → the table's own fields → `Seq`/`Created`/`Updated`.
Headers use real field labels from the metadata call; when that doesn't land,
they're derived from the field id instead — Tulip prefixes user fields with a
five-character handle, so `mreav_product_name` reads as "Product Name" with no
metadata at all. The raw id is on the header's tooltip either way. Values that
look like URLs render as links, timestamps are localised (raw on hover), and
long text is ellipsised to 320px with the full value on hover.

Pagination, column selection, and CSV export are deliberately not built.

### Dev Tools (agent debugging) — `dev-tools` · **default: off** · **developer-only**

Hidden from the popup unless developer mode is on. Defines `window.__tulbelt`
in the extension's isolated world with logging and DOM-inspection helpers
(`log`, `snapshot`, `tree`, `watch`) used by coding agents debugging toggles
without browser access. Run `__tulbelt.copy()` in the DevTools console (with
the context dropdown set to **Tulbelt**) to copy a JSON report with the tenant
hostname redacted. Never touches the page; disabling stops all watchers and
clears the buffer. Workflow and API: [devtools.md](./devtools.md).

### Disable hover tooltips — `disable-tooltips` · **default: off**

Suppresses the tooltip pop-ups on hover-only action buttons (cut, copy, etc.)
while leaving toolbar button tooltips intact.

### Expand all variable paths — `expand-all-variable-paths` · **default: off**

Adds an **Expand paths** button beside the trigger editor's "Copy link to
trigger" control. Clicking it walks every variable trigger button on the page,
briefly opening each dropdown to learn the selected item's full hierarchy, then
rewrites the label to "Object → Field → SubField". A status pill ("3 / 12")
tracks progress. Top-level variables and buttons already patched by
`variable-full-path` are skipped.

Overlaps `variable-full-path`, which now auto-expands already-selected
variables when the trigger editor opens; this toggle is the manual, on-demand
sweep for pages that variable-full-path's one-time pass missed.

### Flatten top menu — `flatten-top-menu` · **default: off**

Lifts the links Tulip hides inside the header's hover dropdowns
(`[data-testid="tulip-header"] a[aria-haspopup="menu"]` — Apps, Shop floor, …)
into the header bar itself and stops the dropdowns opening. On the stock header
that turns Dashboards · Apps · Automations · Shop floor into Dashboards · Apps ·
Tables · Connectors · Functions · Automations · Stations · Interfaces ·
Machines · Edge Devices · Vision — but nothing in that list is hardcoded.
Menu contents vary with the tenant's license and the signed-in user's
permissions, so they're **read off the live header** and cached in
`chrome.storage.local` under `flatNavMenus` (keyed by host + workspace, 7-day
TTL). There are two routes in, because one of them doesn't work everywhere:

1. **A MutationObserver on each trigger's own popper**, armed within milliseconds
   of the header appearing and before anything slow runs. It reads a menu the
   moment Tulip fills it in, whoever opened it — including the user's own cursor.
   No synthetic events, no interference.
2. **A probe** that asks each dropdown to open, trying four routes (hover on the
   anchor, hover on its parent, a document-level pointer move, and focus +
   ArrowDown — `aria-haspopup="menu"` implies a keyboard route, which has nothing
   to do with pointer trust). Nothing here navigates, and the keyboard route
   bails out rather than take focus off something the user is using. Whatever it
   opens, the watcher above records.

   The probe runs one pass **per strategy across every unread menu**, not one
   pass per menu, so the whole header is probed in about the time a single menu
   used to take — reads are scoped per popper, so concurrent menus can't
   contaminate each other. Only the keyboard route is serialised, since focus can
   only be in one place. Roughly 3s for a three-dropdown header that answers
   nothing, against 8s when it went menu by menu.

   It's also remembered per host, in `flatNavProbe`. An instance that answers
   none of the routes is probed on its first three page loads and then left
   alone — otherwise every cold page load pays several seconds for a question
   already answered, with the keyboard route visibly ringing each link as it
   goes. Three visits rather than one because the first load of an instance is
   the worst moment to judge: React may still be wiring the header up. Adding a
   new strategy means bumping `PROBE_VERSION`, or hosts that gave up on the old
   ones would never be retried.

The probe exists because it removes the need for the user to do anything, and it
works on plenty of builds — but not on production Tulip, whose dropdowns ignore
dispatched pointer events entirely, however faithfully shaped. (Verified against
the real site with the toggle off: a real cursor opens every menu, a dispatched
one opens none, `aria-expanded` and the popper's inline `display` unchanged.
Likely an `isTrusted` or real-cursor-position check in whatever floating-element
library the production header uses.) Where that's the case the watcher carries
it, at a cost of one hover per menu, once, before the answer is cached.

Order matters here and was got wrong once: the watcher used to be armed only
_after_ the probe gave up, so a hover made on a fresh page — the most likely
moment for one — landed in the gap and was missed, which is what made this feel
like it needed several tries. When the probe comes up empty, click-through
routing is switched off at the same time, since it re-opens menus the same way
and there's no point charging the user a timeout to discover that.

Reads are scoped to the trigger's own sibling popper, never a document-wide
sweep: a Tulip page carries ~18 poppers and a stray open one gets recorded
against the wrong menu. A reading that saw more rows always wins over one that
saw fewer, and reads settle for 250ms first, so a menu part-way through
rendering never becomes the cached answer.

Flattening is all-or-nothing: a menu that reads as empty never opened, so unless
_every_ dropdown is known the header is left exactly as Tulip drew it and nothing
is cached. Flattening the readable menus around an unread one produces a
half-done nav that reads as a bug — worse than not flattening at all. Set the
developer-only `dev-tools` toggle to record what was read; entries are tagged
`flatten-top-menu` in a `__tulbelt.copy()` report.

A dropdown's parent link is kept only when its own destination isn't already one
of its children, which is why "Shop floor" disappears (same page as its
"Stations" child) while "Apps" survives. Duplicates against links already in the
bar are dropped too.

Status flags ("New", "Upgrade", "Beta", …) are stripped from the text a
flattened link shows. Each harvested row carries two readings: `label` is plain
`textContent`, and every decision about _whether_ a link is flattened runs on it
alone — dedupe, parent/child matching, and the "did this menu read?" test.
`caption` is the stripped version and is only ever the text painted on screen.
Keeping them apart is deliberate: stripping is cosmetic, and the one time it was
wired into the matching path a single over-eager rule emptied every row's name
and stopped whole headers flattening.

The caption can't be taken from `textContent`, because a flag is a pill beside
the name and the two come out glued — `<div>Vision</div><span>New</span>` reads
as `VisionNew`. It's rebuilt from the individual text nodes instead, dropping
parts that are a flag word on their own, with a final sweep for a trailing flag
sharing its text node with the name ("Stations Beta"). That does mean a link
genuinely called "… New" would lose the word, which is why the vocabulary is
kept tight; every step falls back to the wider reading, so a row whose only text
is a flag word keeps it. Extending the vocabulary means bumping `CACHE_VERSION`
so harvested entries are re-read.

Originals are hidden with an attribute + stylesheet rather than removed (React
still owns them), and each flattened link is a plain `<a>` wearing the class and
inline style copied off Tulip's own nav anchors — hashed styled-component names
are read from the page, never hardcoded. Because a clone carries no React Router
binding, a plain left click is routed through the real menu instead: the source
menu is re-opened off-screen (the hidden original still answers synthetic
events) and the matching real anchor is clicked, falling back to ordinary
navigation — permanently, after the first timeout — if that doesn't work.
Modified and middle clicks keep the browser's normal new-tab behavior. The
section highlight is re-homed onto the flattened link whose path best matches
the current URL, using the active/inactive looks read off the real anchors.

### Frequent actions on top — `action-editor-frequent` · **default: on**

Collapses the trigger action-type dropdown (`select[data-testid$="action-editor"]`)
to Data Manipulation, Table Records, Run Function, and Run Connector Function,
plus a "Show all actions…" option. Picking it rebuilds the list with every
action (frequent still pinned on top) and reopens the dropdown via
`showPicker()`. If the current selection isn't one of the four, it stays
visible in the collapsed list. The select is React-controlled, so a sibling
proxy `<select>` is rendered in its place (the real one is hidden) and
selections are forwarded back to React via a native value setter + bubbling
change event.

### Full variable path on selection — `variable-full-path` · **default: on**

In the trigger editor variable picker, when you select a nested Object field,
rewrites the trigger button label from the leaf name only to the full ancestor
path (`Parent → Child → Leaf`). Uses indent depth in the virtualised dropdown
(and optional disabled group-header rows) to reconstruct the hierarchy.

When the trigger editor opens (detected via the "Copy link to trigger" button),
it also runs a one-time pass that briefly opens each already-selected variable
trigger to read its hierarchy and patch the label, so variables chosen before
the toggle ran are expanded too. Skips top-level variables and already-patched
buttons.

### Fuzzy expression autocomplete — `expression-editor-fuzzy` · **default: off** · **developer-only**

Hidden from the popup unless developer mode is on (five quick clicks on the
popup title). In the formula/expression editor popup, replaces the "starts with" filtering of
suggestions with a case-insensitive substring (contains) match. Typing `User.`
surfaces `@Table record.Current User.ID` etc. Arrow keys / Enter / click work
as before. The heaviest feature in the extension: a two-world (isolated + MAIN)
script pair that reads Tulip's full suggestion catalog from React fibers. Deep
dive: [expression-editor-fuzzy-main.md](./expression-editor-fuzzy-main.md).

### Hide base layout triggers — `hide-view-only-triggers` · **default: off**

In the trigger editor, hides inherited base-layout triggers (lock icon, no
copy/view row actions). Other view-only triggers with copy/view buttons stay
visible.

### Hide editor header & palette — `hide-app-editor-chrome` · **default: off**

On app version editor pages only (`/w/…/apps/…/versions/…`), hides the site
header, subheader row (breadcrumbs, Run/Publish), and Add/Icons palette.

### Hide legacy editor tiles — `hide-legacy-tiles` · **default: on**

In the app editor context pane, hides deprecated tiles: Step cycle time, Step
comments, Process cycle time, and App comments.

### Move variables to toolbar — `move-variables-to-toolbar` · **default: off**

Hides the Variables tile in the app editor context pane and mirrors its Edit
button into the top toolbar.

### Option Sets builder — `option-sets-builder` · **default: on**

The **Option Sets** tab of the Tulbelt page ([shell](#the-tulbelt-page-shell)),
at the fake URL `/tulbelt/option-sets`.

The page is a master–detail builder for named option sets typed as Text,
Integer, or Number (type fixed at creation). Options are ordered rows —
▲/▼ reorder, typed value input (integers validated as `/^-?\d+$/`, numbers as
finite floats; invalid/empty values get a red outline, never silent coercion),
optional description per option and per set, ✕ remove, inline confirm on set
delete. Every change autosaves to the tenant origin's localStorage under
`tulbelt-option-sets` (values stored as strings; option order = array order),
so sets are local to this browser and Tulip instance.

The use side (`toggles/option-sets-trigger.js`, same toggle) proxies every
trigger-editor "Select source of data" dropdown (hidden real select + visually
identical proxy, the `action-editor-frequent` pattern) and adds an **Option
Set** entry next to Static value. Picking it silently drives the real row to
Static value and shows two transient pickers — set, then option (descriptions
as tooltips; options invalid for the set's type omitted). On option pick the
set's data type and the option's value are written into the real type select
and value input via native value setters + bubbled events, the pickers
disappear, and the row is exactly the manual Static value entry Tulip would
have produced. Deliberately no reverse flow: existing static values are never
re-displayed as option sets.
Design: `docs/superpowers/specs/2026-07-26-option-sets-builder-design.md`.

### Paste trigger anywhere — `paste-trigger-anywhere` · **default: off**

Adds a paste icon beside every trigger list heading — App started / Completed / Cancelled, a step's On
step enter / On step exit / Timers / Machines & devices, and a widget's or
custom widget's own event sections — so a copied trigger can be pasted onto a
surface Ctrl+V cannot reach: a button trigger onto App started, a step trigger
onto a widget, a custom widget's trigger onto a different custom widget.

Tulip's paste dispatcher picks its destination from the copied trigger's own
binding (no ids → app level, `stepId` → current step, `widgetId` → selected
widget), so there is nothing to aim Ctrl+V at for the app- and step-level lists.
The button names the destination: it rewrites the payload's binding — the
`event`, the `stepId`/`widgetId` pair (which must be **absent**, not null), and
`haltOnError` — and hands the result to Tulip's own paste path via a synthetic
`ClipboardEvent`. Everything else in the payload is passed through as copied.

Widget and custom-widget sections name their own event and carry the
destination widget's id in React props, so the main-world half reads both at
click time rather than keying off a widget type or a heading string — a custom
widget nobody has built yet needs no code change. A widget with a single event
renders no section headings at all, so its panel gets one icon beside the
"Triggers" heading next to Tulip's own "+", which pastes as a generic widget
event and lets Tulip re-derive the component's real one.

Note that Tulip creates the pasted trigger **on paste**, server-side, before the
trigger editor opens — there is no save to confirm it, so an unwanted paste is a
real record to delete. Deep dive:
[paste-trigger-anywhere.md](./paste-trigger-anywhere.md).

### Row actions next to name — `reorder-row-buttons` · **default: on**

On app and folder lists, moves each row's edit and actions buttons next to the
row's name instead of leaving them at the far right.

### Searchable query picker — `query-list-search` · **default: on**

In the Query picker popper (the column of saved-query buttons opened from a
Query field), caps the popper column to 75% of the viewport height — the list
scrolls inside instead of running off the bottom — restores a readable 14px
font (Tulip shrinks it to cram every query in), adds 6px of spacing between the
query buttons, fixes the column to a 280px width so long query names truncate
with an ellipsis (hovering a truncated button shows its full name via a `title`
tooltip), and inserts a sticky search box as the first child. Typing
filters the query buttons by case-insensitive substring; the "Create New Query"
action is never hidden. The popper is
portal-mounted with hashed class names, so it's found by content (the
"Create New Query" button) and its parent column is the element we cap and
filter. Tulip's React buttons are never reparented — only hidden inline — so
the transient popper reverts cleanly on disable.

### Show full trigger value text — `trigger-value-full-text` · **default: on**

In the trigger editor, widens Value Picker text boxes
(`input[aria-label="Value Picker"]`, e.g. static Text values) so long values
are readable: `field-sizing: content` grows the input to its own text and the
fixed-width wrapper around it is released, both capped at the row width. A
min-width floor at Tulip's stock ~175px means the toggle only ever adds width,
so a value that already fits looks exactly as it does with the toggle off. For
values still too long for the row, hovering the input shows the full text as a
native `title` tooltip, read off the input at mouseover time (never kept in
sync, so it can't go stale); a `title` Tulip set itself is left alone, and ours
are removed on disable.

Read-only by design. An earlier version hid the real input and rendered an
editable `<textarea>` proxy so long values could soft-wrap onto several lines —
the only way to get wrapping, since `input[type=text]` cannot wrap by spec.
That required forwarding every keystroke back into the hidden input via the
native value setter, and those writes never reached Tulip's saved trigger:
edits made in the proxy were silently dropped on save while edits typed into
the stock input saved fine. Nothing here reads or writes the value, so the real
input stays the only source of truth and there is no save path to break.

### Snap widgets to 10px grid — `snap-to-grid` · **default: off**

On app version editor pages only (`/w/…/apps/…/versions/…` or
`/apps/…/versions/…`), snaps a widget's position and size to the nearest
multiple of 10 when a drag or resize ends. Tulip owns the drag; a press that
doesn't move past a small threshold counts as a click and snaps nothing. After
a real drag, the moved values (Tulip commits them to the pane a few frames
late, so they're polled for) are rounded and written back through the
context-pane number inputs (`context-pane-tool-position-x/-y`, `-size-w/-h`):
the value is set via a native setter, then `input`/`change` + Enter + blur fire
so Tulip's commit-on-blur handler persists it. A move snaps only X/Y, a resize
snaps size (and X/Y if the handle moved them); fields the interaction didn't
change — and values typed directly into the inputs — are left untouched.

### Sort tables by newest — `table-default-sort` · **default: on**

On tulip.co table views, redirects to a URL that sorts by `_createdAt`
descending so the most recently created rows are on top. Implemented as a
`declarativeNetRequest` redirect rule plus a `background.js` bridge that catches
SPA navigations DNR misses. The bridge ignores Back/Forward navigations
(`forward_back` transition qualifier) and instead steps back past the un-sorted
duplicate entry the redirect leaves behind — otherwise re-sorting on Back made
the browser Back button "go to itself".

### Strip "Tulip | " from tab titles — `strip-tab-title-prefix` · **default: off**

Removes the leading "Tulip | " prefix from browser tab/window titles so the
page-specific name shows first.

### Visual filters editor — `filters-builder` · **default: on**

On connector function pages, replaces the JSON text box for the `filters` query
parameter with a row-per-filter builder (field, function, arg), built on a
model of Tulip's pill field. The field's value is an ordered token list (one
`<input>` per text run, one `.param-pill` per variable) and pills always sit
inside JSON string literals — the enclosing quotes live in the neighboring text
tokens. So the canonical text form is the in-order concatenation with each pill
spliced in as `$Label$`, with no JSON-string-state scanning. A whole-arg
`$Name$` renders as a chip in the builder (× clears it back to a text input);
typing `$Name$` in an arg field creates one. The token list is only how the
field renders: its React state (probed via the component fiber) is the
canonical string itself, owned by the nearest ancestor with
`{ value: string, onChange }` props. Writes therefore skip token surgery
entirely — the isolated half dispatches the new string to
`toggles/filters-builder-main.js` (MAIN world), which calls that onChange
directly; Tulip re-renders inputs and pills from the string. Nothing is written
until the user edits a builder field.

## The Tulbelt page shell

`toggles/tulbelt-page.js` owns one full-window page reached from the account
dropdown (the menu with My profile / Sign out) — the only entry point on
purpose, since the account _settings_ pages aren't available to every user, so
nothing hangs off the settings sidebar. The item is anchored on
`li[data-testid="my-profile-menuitem"]` and placed above Sign out. The clone
carries no React fiber, so Tulip's delegated handlers never fire for it, and
the click dispatches a synthetic Escape _from the link_ (React delegates from
its root container, so an event fired on `document` would never reach the
popup) to dismiss the menu.

The page is a fixed panel appended to `<body>` with its own Back bar and tab
strip, owing nothing to Tulip's layout so it renders identically at any
permission level. Its URL is set with `history.pushState` to `/tulbelt/<tab>`,
which React Router never observes, so Tulip keeps rendering whatever it had
underneath while we cover it.

The panel covers the app, so Back (or Escape, unless focus is in a field) is
the only way out: it pops our own history entry when we pushed one, otherwise
it navigates to the last real path. Tab switches use `replaceState` so Back
leaves Tulbelt rather than walking the tabs. Hard reloads on a fake URL
re-activate; because it's a route Tulip doesn't know, its router may redirect
out from under us shortly after load, so for 5s we reclaim the URL with
`replaceState` and keep the redirect target as the exit path.

The shell has **no toggle of its own**. Tabs come from other toggles, which
register while they're on:

```js
window.__tulbeltPage.register({
  id: "data-queries",              // tab id; also the URL tail
  label: "Data Queries",           // tab strip label
  containerId: "tulbelt-dq-page",  // id set on the content div, for CSS scoping
  order: 20,                       // tab strip position, ascending
  mount(container) { ... },        // fill the content div
  unmount() { ... },               // optional; called when the tab closes
});
window.__tulbeltPage.unregister("data-queries");
```

Registration _is_ the enable signal, so the account-menu item appears when the
first page registers and disappears when the last one unregisters. The tab strip
hides itself when only one page is registered — a lone tab is a label, not a
choice, and the Back bar already says Tulbelt. Turning off the toggle for the tab
you're currently looking at falls back to the first remaining tab (and takes the
URL with it) rather than leaving an empty panel.

Current pages: [Data queries](#data-queries--data-queries--default-off)
(`order: 10`) and [Option Sets](#option-sets-builder--option-sets-builder--default-on)
(`order: 20`). Data Queries leads, so it is also the tab the page opens on when
no tab is named in the URL.
