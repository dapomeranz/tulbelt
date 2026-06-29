// Registry of toggleable behaviors. Each entry with a `rule` becomes a
// declarativeNetRequest dynamic rule when its toggle is on. Add a new entry
// to ship a new toggle — the popup and background sync read from here.

// Old toggles merged into `compact-app-editor-header`. Kept here so getToggles
// can migrate existing users once.
export const LEGACY_COMPACT_APP_EDITOR_HEADER_IDS = [
  "hide-app-editor-palette-icons",
  "hide-subheader-workspace-label",
];

export const FEATURES = [
  {
    id: "table-default-sort",
    name: "Sort Tables New to Old",
    description:
      'On the tables page, redirects to a URL that sorts by _createdAt descending. Also fixes the browser Back button, which this redirect otherwise made "go to itself".',
    defaultEnabled: true,
    major: true,
    rule: {
      condition: {
        // Group 2 captures the path tail including the optional /w/<ws> prefix
        // so it always participates — Chrome DNR's regexSubstitution silently
        // drops the redirect when a backreference targets a non-participating
        // optional group.
        regexFilter: "^https://([^/]+)\\.tulip\\.co((?:/w/[^/]+)?/table/[^?]+)$",
        resourceTypes: ["main_frame"],
      },
      action: {
        type: "redirect",
        redirect: {
          regexSubstitution:
            "https://\\1.tulip.co\\2?sortOptions=%5B%7B%22sortBy%22%3A%22_createdAt%22%2C%22sortDir%22%3A%22desc%22%7D%5D&offset=0",
        },
      },
    },
  },
  {
    id: "reorder-row-buttons",
    name: "Quicker App Button Access",
    description:
      "On app and folder lists, move the edit and actions buttons next to each row’s name instead of the far right.",
    defaultEnabled: true,
    major: false,
  },
  {
    id: "auto-snapshot",
    name: "Auto-Snapshot Every 15 Minutes",
    description:
      "Track active editing time per app and automatically create a snapshot every 15 minutes of activity.",
    defaultEnabled: true,
    major: true,
  },
  {
    id: "hide-legacy-tiles",
    name: "Hide Minor Legacy Features",
    description:
      "In the app editor context pane, hide deprecated tiles: Step cycle time, Step comments, Process cycle time, and App comments.",
    defaultEnabled: true,
    major: false,
  },
  {
    id: "disable-tooltips",
    name: "Disable Copy Hover Tooltips",
    description: "Suppress the tooltip pop-ups on hover-only action buttons which cause misclicks.",
    defaultEnabled: true,
    major: false,
  },
  {
    id: "hide-view-only-triggers",
    name: "Hide Base Layout Triggers",
    description: "In the trigger editor, hide inherited base-layout triggers.",
    defaultEnabled: false,
    major: true,
  },
  {
    id: "move-variables-to-toolbar",
    name: "Variables Button to Toolbar",
    description: "Move the Variables tile in the app editor context pane to the top toolbar.",
    defaultEnabled: true,
    major: true,
  },
  {
    id: "dark-mode",
    name: "Dark Mode",
    description:
      "Apply a dark color scheme to tulip.co via filter-inversion (invert, contrast, brightness on the document; restored regions use the exact inverse so previews, canvas, images, and video stay hue-faithful). Targeted tweaks for specific surfaces are layered on top.",
    defaultEnabled: false,
    major: true,
  },
  {
    id: "hide-app-editor-chrome",
    name: "Full Screen Editor",
    description:
      "On app version editor pages only (`/w/…/apps/…/versions/…`), hide the site header, subheader row (breadcrumbs, Run/Publish), and Add/Icons palette.",
    defaultEnabled: false,
    major: true,
  },
  {
    id: "compact-app-editor-header",
    name: "Slim App Editor Header",
    description:
      "In the app editor: hide the workspace name beside breadcrumbs; hide leading icons on palette buttons (Add, Icons, …, Forward/Back); tighten vertical padding on the subheader and palette rows.",
    defaultEnabled: true,
    major: true,
  },
  {
    id: "context-menu-copy-cut",
    name: "Right Click -> Copy Widget",
    description:
      "In the app editor canvas widget context menu (Delete / Move To Front / Back), add Copy (Ctrl+C) and Cut (Ctrl+X) rows that trigger those shortcuts when clicked.",
    defaultEnabled: true,
    major: true,
  },
  {
    id: "strip-tab-title-prefix",
    name: 'Strip "Tulip | " from Tab Titles',
    description:
      'Remove the leading "Tulip | " prefix from browser tab/window titles so the page-specific name shows first.',
    defaultEnabled: true,
    major: true,
  },
  {
    id: "filters-builder",
    name: "Visual Tulip API Filters Builder",
    description:
      "On connector function pages, replace the JSON text box for the `filters` query parameter with a row-per-filter builder (field, function, arg). Variable pills round-trip as `$Name$` strings; type `$Name$` directly in an arg field to reference a variable.",
    defaultEnabled: true,
    major: true,
  },
  {
    id: "variable-full-path",
    name: "Show Full Variable Path on Selection",
    description:
      'In the trigger editor, show the full ancestor path ("Object → Field → SubField") for nested Object fields instead of just the leaf field name. Patches each variable as you select it, and also auto-expands all already-selected variables once when the trigger editor opens.',
    defaultEnabled: true,
    major: true,
  },
  {
    id: "expression-editor-fuzzy",
    name: "Improved Expression Autocomplete",
    description:
      "In the formula/expression editor popup, replace the “starts with” filtering of suggestions with a case-insensitive substring (contains) match. Typing `User.` surfaces `@Table record.Current User.ID` etc. Arrow keys / Enter / click work as before. Ctrl+Enter (Cmd+Enter on Mac) saves.",
    defaultEnabled: false,
    major: true,
    developerOnly: true,
  },
  {
    id: "collapse-tables-tile",
    name: "Collapse Records Rows",
    description:
      'On app editor pages, click the caret at the right edge of a table row in the Tables tile to collapse/expand its Query, Record Placeholder, and linked record buttons. Each table starts collapsed — only the icon, table name, and a two-line "· N placeholders" / "· M aggregations" summary show until you expand it. The table name still opens its menu on click. A "Collapse all" / "Expand all" toggle below the Add Table row collapses or expands every table at once.',
    defaultEnabled: true,
    major: true,
  },
  {
    id: "action-editor-frequent",
    name: "Frequent Trigger Actions On Top",
    description:
      "Collapse the trigger action-type dropdown to Data Manipulation, Table Records, Run Function, and Run Connector Function, plus a “Show all actions…” option that expands the full list.",
    defaultEnabled: true,
    major: true,
  },
  {
    id: "snap-to-grid",
    name: "Snap Widgets to 10px Grid",
    description:
      "In the app editor, snap a widget’s position and size to the nearest multiple of 10 when you finish dragging or resizing it. Only the values changed by that interaction are snapped; clicking a widget or manually editing the X/Y/W/H fields is left alone.",
    defaultEnabled: true,
    major: true,
  },
  {
    id: "query-list-search",
    name: "Searchable Table Queries",
    description:
      "In the Query picker popup, cap its height to the screen (the list scrolls inside) and add a sticky search box at the top that filters the saved queries by name as you type.",
    defaultEnabled: true,
    major: true,
  },
  {
    id: "history-search",
    name: "Quick Search History (⌘K / Ctrl+K)",
    description:
      "Logs every app, table, and connector function you open and adds a ⌘K (Ctrl+K on Windows/Linux) search palette to jump back to any of them by name or folder. Enter opens in the current tab; Ctrl/Cmd+Enter opens a new tab.",
    defaultEnabled: true,
    major: true,
  },
  {
    id: "app-list-date-columns",
    name: "App List: Created & Completed Columns",
    description:
      'On app/folder lists, add "Created" and "Last Completed" columns (sourced from the apps API the page already loads) after the Last Modified column.',
    defaultEnabled: false,
    major: false,
  },
  {
    id: "submitted-pending-approvals",
    name: "Pending Approvals: Show Apps I Submitted",
    description:
      'On the Pending Approvals page, adds a toggle pill next to the page heading that switches between "Pending my approval" (Tulip\'s default view) and "Submitted by me" — apps you submitted for approval that still have at least one pending sign-off from someone else.',
    defaultEnabled: true,
    major: true,
  },
  {
    id: "dev-tools",
    name: "Dev Tools (Agent Debugging)",
    description:
      "Defines window.__tulbelt (isolated world) with logging and DOM-inspection helpers for agent-driven debugging. Run __tulbelt.copy() in the DevTools console (Tulbelt context) to copy a redacted JSON report. See docs/devtools.md.",
    defaultEnabled: false,
    major: false,
    developerOnly: true,
  },
];

// Popup list grouping — set `major: true` on a feature to pin it in the
// "Major" section; set `developerOnly: true` to hide until developer mode
// (five clicks on the popup title). Reload the extension after editing this file.
export function getPopupFeatureGroups({ showDeveloperFeatures = false } = {}) {
  const major = [];
  const more = [];
  for (const feature of FEATURES) {
    if (feature.developerOnly === true && !showDeveloperFeatures) continue;
    if (feature.major === true) major.push(feature);
    else more.push(feature);
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  major.sort(byName);
  more.sort(byName);
  return { major, more };
}

export const STORAGE_KEY = "toggles";
export const DEVELOPER_MODE_KEY = "developerMode";

/** Popup-only features; forced off in getToggles() unless developer mode is on. */
export async function getDeveloperMode() {
  const { [DEVELOPER_MODE_KEY]: on } = await chrome.storage.local.get(DEVELOPER_MODE_KEY);
  return on === true;
}

export async function setDeveloperMode(enabled) {
  await chrome.storage.local.set({ [DEVELOPER_MODE_KEY]: enabled });
}

// Rule IDs must be stable positive integers. Index-based keeps them predictable
// across reloads as long as the order of FEATURES doesn't change.
export function ruleIdFor(index) {
  return index + 1;
}

// Resolve a single feature's value from raw stored toggles, falling back to its
// declared default (and applying the one-time legacy migration for the merged
// compact-app-editor-header toggle).
function resolveDefault(stored, feature) {
  if (feature.id === "compact-app-editor-header") {
    if (Object.prototype.hasOwnProperty.call(stored, feature.id)) {
      return stored[feature.id];
    }
    const migrated = LEGACY_COMPACT_APP_EDITOR_HEADER_IDS.some((id) => stored[id] === true);
    return migrated || feature.defaultEnabled;
  }
  return stored[feature.id] ?? feature.defaultEnabled;
}

export async function getToggles() {
  const { [STORAGE_KEY]: stored = {} } = await chrome.storage.local.get(STORAGE_KEY);
  const developerMode = await getDeveloperMode();
  const result = {};
  for (const f of FEATURES) {
    let enabled = resolveDefault(stored, f);
    if (f.developerOnly === true && !developerMode) enabled = false;
    result[f.id] = enabled;
  }
  return result;
}

// Persist defaults into storage so that `chrome.storage` is the single runtime
// source of truth — content scripts then read it directly without each
// hardcoding its own default. Only writes keys that are missing, so it never
// clobbers a choice the user has already made. Because it runs on install,
// update, and startup (see background.js), any toggle shipped in a later
// version gets its default seeded the next time the extension loads.
export async function seedDefaults() {
  const { [STORAGE_KEY]: stored = {} } = await chrome.storage.local.get(STORAGE_KEY);
  const next = { ...stored };
  let changed = false;
  for (const f of FEATURES) {
    if (Object.prototype.hasOwnProperty.call(next, f.id)) continue;
    // Developer-only features must never be seeded on: content scripts read
    // raw storage, so a true here would activate them for non-developer users
    // even though getToggles() and the popup report them off.
    next[f.id] = f.developerOnly === true ? false : resolveDefault(stored, f);
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

export async function setToggle(id, enabled) {
  const { [STORAGE_KEY]: stored = {} } = await chrome.storage.local.get(STORAGE_KEY);
  await chrome.storage.local.set({
    [STORAGE_KEY]: { ...stored, [id]: enabled },
  });
}
