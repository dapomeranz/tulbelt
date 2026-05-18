# Toggle reference

Every toggle Tulbelt ships, what it changes, and its out-of-the-box state.

The **authoritative** list and exact behavior live in [`features.js`](../features.js)
and are rendered live in the popup. This page is a human-readable companion —
if the two ever disagree, `features.js` wins.

"Default" is the state a fresh install starts in; you can flip any toggle from
the popup at any time, and every toggle cleanly reverts when switched off.

Toggles are split into **major** and **minor** by relative implementation
complexity — not by how useful they are. *Major* toggles are large, stateful,
or reach deep into Tulip's React internals (hundreds to ~1500 lines, sometimes
across two script worlds). *Minor* toggles are small, self-contained DOM/CSS
tweaks or a declarative redirect.

## Major toggles

These carry the most logic and the most surface area for Tulip UI changes to
break them. Listed most-complex first.

### Fuzzy expression autocomplete — `expression-editor-fuzzy` · **default: off**

In the formula/expression editor popup, replaces the "starts with" filtering of
suggestions with a case-insensitive substring (contains) match. Typing `User.`
surfaces `@Table record.Current User.ID` etc. Arrow keys / Enter / click work
as before. The heaviest feature in the extension: a two-world (isolated + MAIN)
script pair that reads Tulip's full suggestion catalog from React fibers. Deep
dive: [expression-editor-fuzzy-main.md](./expression-editor-fuzzy-main.md).

### Visual filters editor — `filters-builder` · **default: off**

On connector function pages, replaces the JSON text box for the `filters` query
parameter with a row-per-filter builder (field, function, arg). Variable pills
round-trip as `$Name$` strings; type `$Name$` directly in an arg field to
reference a variable.

### Copy/Cut in widget menu — `context-menu-copy-cut` · **default: on**

In the app editor canvas widget context menu (Delete / Move To Front / Back),
adds Copy (Ctrl+C) and Cut (Ctrl+X) rows that synthesize those keyboard
shortcuts when clicked.

### Auto-snapshot every 15 active min — `auto-snapshot` · **default: off**

In the app editor, tracks active editing time per app and automatically creates
a snapshot after each 15 minutes of activity. Stateful — it persists per-app
activity time across navigation.

## Minor toggles

Small, self-contained tweaks. Listed in `features.js` order.

### Sort tables by newest — `table-default-sort` · **default: on**

On tulip.co table views, redirects to a URL that sorts by `_createdAt`
descending so the most recently created rows are on top. Implemented as a
`declarativeNetRequest` redirect rule rather than a content script.

### Row actions next to name — `reorder-row-buttons` · **default: on**

On app and folder lists, moves each row's edit and actions buttons next to the
row's name instead of leaving them at the far right.

### Hide legacy editor tiles — `hide-legacy-tiles` · **default: on**

In the app editor context pane, hides deprecated tiles: Step cycle time, Step
comments, Process cycle time, and App comments.

### Disable hover tooltips — `disable-tooltips` · **default: off**

Suppresses the tooltip pop-ups on hover-only action buttons (cut, copy, etc.)
while leaving toolbar button tooltips intact.

### Hide view-only triggers — `hide-view-only-triggers` · **default: off**

In the trigger editor, hides locked/read-only triggers so only editable ones
remain in the list.

### Move variables to toolbar — `move-variables-to-toolbar` · **default: off**

Hides the Variables tile in the app editor context pane and mirrors its Edit
button into the top toolbar.

### Hide editor header & palette — `hide-app-editor-chrome` · **default: off**

On app version editor pages only (`/w/…/apps/…/versions/…`), hides the site
header, subheader row (breadcrumbs, Run/Publish), and Add/Icons palette.

### Compact app editor header — `compact-app-editor-header` · **default: off**

In the app editor: hides the workspace name beside breadcrumbs, hides leading
icons on palette buttons (Add, Icons, …, Forward/Back), and tightens vertical
padding on the subheader and palette rows. (Supersedes the older
`hide-app-editor-palette-icons` and `hide-subheader-workspace-label` toggles,
which migrate automatically.)

### Dark mode — `dark-mode` · **default: off**

Applies a dark color scheme to tulip.co via filter-inversion (invert, contrast,
brightness on the document; restored regions use the exact inverse so previews,
canvas, images, and video stay hue-faithful). Targeted tweaks for specific
surfaces are layered on top.

### Strip "Tulip | " from tab titles — `strip-tab-title-prefix` · **default: off**

Removes the leading "Tulip | " prefix from browser tab/window titles so the
page-specific name shows first.
