// Registry of toggleable behaviors. Each entry with a `rule` becomes a
// declarativeNetRequest dynamic rule when its toggle is on. Add a new entry
// to ship a new toggle — the popup and background sync read from here.

export const FEATURES = [
  {
    id: 'table-default-sort',
    name: 'Sort tables by newest',
    description:
      'On tulip.co table views, redirect to a URL that sorts by _createdAt descending.',
    defaultEnabled: true,
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
    name: 'Row actions next to name',
    description:
      'On app and folder lists, move the edit and actions buttons next to each row’s name instead of the far right.',
    defaultEnabled: true,
  },
  {
    id: 'auto-snapshot',
    name: 'Auto-snapshot every 30 active min',
    description:
      'In the app editor, track active editing time per app and automatically create a snapshot after each 30 minutes of activity.',
    defaultEnabled: false,
  },
  {
    id: 'hide-legacy-tiles',
    name: 'Hide legacy editor tiles',
    description:
      'In the app editor context pane, hide deprecated tiles: Step cycle time, Step comments, Process cycle time, and App comments.',
    defaultEnabled: true,
  },
  {
    id: 'disable-tooltips',
    name: 'Disable hover tooltips',
    description:
      'Suppress the tooltip pop-ups that appear when hovering buttons and icons marked with data-toggle="tooltip".',
    defaultEnabled: false,
  },
  {
    id: 'hide-view-only-triggers',
    name: 'Hide view-only triggers',
    description:
      'In the trigger editor, hide locked/read-only triggers so only editable ones remain in the list.',
    defaultEnabled: false,
  },
];

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
    result[f.id] = stored[f.id] ?? f.defaultEnabled;
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
