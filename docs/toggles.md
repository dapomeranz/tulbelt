# Toggle reference

Every toggle Tulbelt ships, what it changes, and its out-of-the-box state.

The **authoritative** list and exact behavior live in [`features.js`](../features.js)
and are rendered live in the popup. This page is a human-readable companion —
if the two ever disagree, `features.js` wins.

"Default" is the state a fresh install starts in; you can flip any toggle from
the popup at any time, and every toggle cleanly reverts when switched off.

Toggles are listed alphabetically in one ungrouped run, as the popup shows them.
(The popup sorts by each toggle's `name`; the headings below are this page's own
titles, so the two orders are close but not identical.)

### App list Created/Completed columns — `app-list-date-columns` · **default: off**

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

### Copy/Cut in widget menu — `context-menu-copy-cut` · **default: off**

In the app editor canvas widget context menu (Delete / Move To Front / Back),
adds Copy (Ctrl+C) and Cut (Ctrl+X) rows that synthesize those keyboard
shortcuts when clicked.

### Dark mode — `dark-mode` · **default: off**

Applies a dark color scheme to tulip.co via filter-inversion (invert, contrast,
brightness on the document; restored regions use the exact inverse so previews,
canvas, images, and video stay hue-faithful). Targeted tweaks for specific
surfaces are layered on top.

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
*after* the probe gave up, so a hover made on a fresh page — the most likely
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
*every* dropdown is known the header is left exactly as Tulip drew it and nothing
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
`textContent`, and every decision about *whether* a link is flattened runs on it
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

### Frequent actions on top — `action-editor-frequent` · **default: off**

Collapses the trigger action-type dropdown (`select[data-testid$="action-editor"]`)
to Data Manipulation, Table Records, Run Function, and Run Connector Function,
plus a "Show all actions…" option. Picking it rebuilds the list with every
action (frequent still pinned on top) and reopens the dropdown via
`showPicker()`. If the current selection isn't one of the four, it stays
visible in the collapsed list. The select is React-controlled, so a sibling
proxy `<select>` is rendered in its place (the real one is hidden) and
selections are forwarded back to React via a native value setter + bubbling
change event.

### Full variable path on selection — `variable-full-path` · **default: off**

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

### Hide legacy editor tiles — `hide-legacy-tiles` · **default: off**

In the app editor context pane, hides deprecated tiles: Step cycle time, Step
comments, Process cycle time, and App comments.

### Move variables to toolbar — `move-variables-to-toolbar` · **default: off**

Hides the Variables tile in the app editor context pane and mirrors its Edit
button into the top toolbar.

### Option Sets builder — `option-sets-builder` · **default: off**

On `/account/*` pages, adds an **Option Sets** item to the Account Settings
sidebar. Clicking it shows a Tulbelt-owned page at the fake URL
`/account/option-sets`: the URL is set with `history.pushState`, which React
Router never observes, so Tulip's header and sidebar stay real while the
content pane is hidden and replaced with our container. The "selected" nav
style is copied from whichever real item currently has it (detected as the
minority className — hashes are never hardcoded). Clicking any real link
deactivates and `replaceState`s back to the last real settings path so the
router and URL agree; back/forward and hard reloads on the fake URL re-activate
over whatever Tulip renders.

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

### Row actions next to name — `reorder-row-buttons` · **default: off**

On app and folder lists, moves each row's edit and actions buttons next to the
row's name instead of leaving them at the far right.

### Searchable query picker — `query-list-search` · **default: off**

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

### Show full trigger value text — `trigger-value-full-text` · **default: off**

In the trigger editor, when a Value Picker text box's content is longer than
the box (`input[aria-label="Value Picker"]`, e.g. static Text values), replaces
it with an editable box that sizes to its text: beside the selects while the
text fits in the leftover space, on its own line when it doesn't, and
stretched to the full row width (soft-wrapping onto 2+ lines and auto-growing)
only once the text is longer than the row. Values that fit keep the
untouched native input, and swaps in either direction only happen while the
field isn't focused (on mount or blur), so the caret is never yanked
mid-typing. Built from the same two patterns as other trigger toggles: the
real React-controlled input is hidden (wrapper and all — its wrapper has a
fixed 35px height that would clip anything taller) and a `<textarea>` proxy is
inserted after the row's `triggerUnitStyles` container; edits forward back via
the native value setter + bubbling input/change events. Enter commits
(forwarded to the real input) instead of inserting a newline — the underlying
value can't hold line breaks.

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

### Sort tables by newest — `table-default-sort` · **default: off**

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

### Visual filters editor — `filters-builder` · **default: off**

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
