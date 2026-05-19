// Registry of toggleable behaviors. Each entry with a `rule` becomes a
// declarativeNetRequest dynamic rule when its toggle is on. Add a new entry
// to ship a new toggle — the popup and background sync read from here.

// Old toggles merged into `compact-app-editor-header`. Kept here so getToggles
// can migrate existing users once.
export const LEGACY_COMPACT_APP_EDITOR_HEADER_IDS = [
  'hide-app-editor-palette-icons',
  'hide-subheader-workspace-label',
];

export const FEATURES = [
  {
    id: 'table-default-sort',
    name: 'Sort Tables New to Old',
    description:
      'On the tables page, redirects to a URL that sorts by _createdAt descending.',
    defaultEnabled: true,
    major: true,
    rule: {
      condition: {
        // Group 2 captures the path tail including the optional /w/<ws> prefix
        // so it always participates — Chrome DNR's regexSubstitution silently
        // drops the redirect when a backreference targets a non-participating
        // optional group.
        regexFilter:
          '^https://([^/]+)\\.tulip\\.co((?:/w/[^/]+)?/table/[^?]+)$',
        resourceTypes: ['main_frame'],
      },
      action: {
        type: 'redirect',
        redirect: {
          regexSubstitution:
            'https://\\1.tulip.co\\2?sortOptions=%5B%7B%22sortBy%22%3A%22_createdAt%22%2C%22sortDir%22%3A%22desc%22%7D%5D&offset=0',
        },
      },
    },
  },
  {
    id: 'reorder-row-buttons',
    name: 'Quicker App Button Access',
    description:
      'On app and folder lists, move the edit and actions buttons next to each row’s name instead of the far right.',
    defaultEnabled: true,
    major: false,
  },
  {
    id: 'auto-snapshot',
    name: 'Auto-Snapshot Every 15 Minutes',
    description:
      'Track active editing time per app and automatically create a snapshot every 15 minutes of activity.',
    defaultEnabled: true,
    major: true,
  },
  {
    id: 'hide-legacy-tiles',
    name: 'Hide Minor Legacy Features',
    description:
      'In the app editor context pane, hide deprecated tiles: Step cycle time, Step comments, Process cycle time, and App comments.',
    defaultEnabled: true,
    major: false,
  },
  {
    id: 'disable-tooltips',
    name: 'Disable Copy Hover Tooltips',
    description:
      'Suppress the tooltip pop-ups on hover-only action buttons which cause misclicks.',
    defaultEnabled: true,
    major: true,
  },
  {
    id: 'hide-view-only-triggers',
    name: 'Hide Base Layout Triggers',
    description:
      'In the trigger editor, hide inherited base-layout triggers.',
    defaultEnabled: true,
    major: true,
  },
  {
    id: 'move-variables-to-toolbar',
    name: 'Variables Button to Toolbar',
    description:
      'Move the Variables tile in the app editor context pane to the top toolbar.',
    defaultEnabled: true,
    major: true,
  },
  {
    id: 'dark-mode',
    name: 'Dark Mode',
    description:
      'Apply a dark color scheme to tulip.co via filter-inversion (invert, contrast, brightness on the document; restored regions use the exact inverse so previews, canvas, images, and video stay hue-faithful). Targeted tweaks for specific surfaces are layered on top.',
    defaultEnabled: false,
    major: true,
  },
  {
    id: 'hide-app-editor-chrome',
    name: 'Full Screen Editor',
    description:
      'On app version editor pages only (`/w/…/apps/…/versions/…`), hide the site header, subheader row (breadcrumbs, Run/Publish), and Add/Icons palette.',
    defaultEnabled: false,
    major: true,
  },
  {
    id: 'compact-app-editor-header',
    name: 'Slim App Editor Header',
    description:
      'In the app editor: hide the workspace name beside breadcrumbs; hide leading icons on palette buttons (Add, Icons, …, Forward/Back); tighten vertical padding on the subheader and palette rows.',
    defaultEnabled: false,
    major: true,
  },
  {
    id: 'context-menu-copy-cut',
    name: 'Right Click -> Copy Widget',
    description:
      'In the app editor canvas widget context menu (Delete / Move To Front / Back), add Copy (Ctrl+C) and Cut (Ctrl+X) rows that trigger those shortcuts when clicked.',
    defaultEnabled: true,
    major: true,
  },
  {
    id: 'strip-tab-title-prefix',
    name: 'Strip "Tulip | " from Tab Titles',
    description:
      'Remove the leading "Tulip | " prefix from browser tab/window titles so the page-specific name shows first.',
    defaultEnabled: true,
    major: true,
  },
  {
    id: 'filters-builder',
    name: 'Visual Tulip API Filters Builder',
    description:
      'On connector function pages, replace the JSON text box for the `filters` query parameter with a row-per-filter builder (field, function, arg). Variable pills round-trip as `$Name$` strings; type `$Name$` directly in an arg field to reference a variable.',
    defaultEnabled: true,
    major: true,
  },
  {
    id: 'expression-editor-fuzzy',
    name: 'Improved Expression Autocomplete',
    description:
      'In the formula/expression editor popup, replace the “starts with” filtering of suggestions with a case-insensitive substring (contains) match. Typing `User.` surfaces `@Table record.Current User.ID` etc. Arrow keys / Enter / click work as before. Ctrl+Enter (Cmd+Enter on Mac) saves.',
    defaultEnabled: true,
    major: true,
  },
];

// Popup list grouping — set `major: true` on a feature to pin it in the
// "Major" section; reload the extension after editing this file.
export function getPopupFeatureGroups() {
  const major = [];
  const more = [];
  for (const feature of FEATURES) {
    if (feature.major === true) major.push(feature);
    else more.push(feature);
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  major.sort(byName);
  more.sort(byName);
  return { major, more };
}

export const STORAGE_KEY = 'toggles';

// Rule IDs must be stable positive integers. Index-based keeps them predictable
// across reloads as long as the order of FEATURES doesn't change.
export function ruleIdFor(index) {
  return index + 1;
}

export async function getToggles() {
  const { [STORAGE_KEY]: stored = {} } =
    await chrome.storage.local.get(STORAGE_KEY);
  const result = {};
  for (const f of FEATURES) {
    if (f.id === 'compact-app-editor-header') {
      if (Object.prototype.hasOwnProperty.call(stored, f.id)) {
        result[f.id] = stored[f.id];
      } else {
        const migrated = LEGACY_COMPACT_APP_EDITOR_HEADER_IDS.some(
          (id) => stored[id] === true,
        );
        result[f.id] = migrated || f.defaultEnabled;
      }
    } else {
      result[f.id] = stored[f.id] ?? f.defaultEnabled;
    }
  }
  return result;
}

export async function setToggle(id, enabled) {
  const { [STORAGE_KEY]: stored = {} } =
    await chrome.storage.local.get(STORAGE_KEY);
  await chrome.storage.local.set({
    [STORAGE_KEY]: { ...stored, [id]: enabled },
  });
}
