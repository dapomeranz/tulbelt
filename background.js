import { FEATURES, STORAGE_KEY, getToggles, ruleIdFor, seedDefaults } from "./features.js";

const TABLE_FEATURE_ID = "table-default-sort";
const TABLE_URL_RE = /^https:\/\/([^/]+)\.tulip\.co((?:\/w\/[^/]+)?\/table\/[^?]+)$/;
const SORT_QUERY =
  "sortOptions=%5B%7B%22sortBy%22%3A%22_createdAt%22%2C%22sortDir%22%3A%22desc%22%7D%5D&offset=0";

// Serializes overlapping syncRules() calls. onInstalled and onStartup (and a
// storage change) can fire close together; without this, two concurrent runs
// both read the same `existing` set and then both try to add the same rule id,
// producing "Rule with id N does not have a unique ID". Chaining each call onto
// the previous one guarantees getDynamicRules/updateDynamicRules run atomically.
let syncRulesChain = Promise.resolve();

function syncRules() {
  syncRulesChain = syncRulesChain.then(doSyncRules, doSyncRules);
  return syncRulesChain;
}

async function doSyncRules() {
  const toggles = await getToggles();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  const addRules = FEATURES.flatMap((feature, i) => {
    if (!feature.rule || !toggles[feature.id]) return [];
    return [{ id: ruleIdFor(i), priority: 1, ...feature.rule }];
  });

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules,
  });
}

const TABLE_NAV_FILTER = {
  url: [{ hostSuffix: ".tulip.co", pathContains: "/table/" }],
};

// A Back/Forward landed on the un-sorted table entry the redirect leaves behind
// (the sorted entry sits one step forward of it). Re-sorting it — or just
// letting it sit — is what made the Back button "go to itself"; step back past
// the duplicate to the real previous page. The hop from the sorted entry (a
// full document load via chrome.tabs.update) back to the un-sorted one crosses
// documents and fires onCommitted, while same-document hops fire
// onHistoryStateUpdated, so both events route here. Returns true when handled.
async function skipSortDuplicate(details) {
  if (details.frameId !== 0) return false;
  if (!details.transitionQualifiers?.includes("forward_back")) return false;
  const toggles = await getToggles();
  if (!toggles[TABLE_FEATURE_ID]) return false;
  if (!TABLE_URL_RE.test(details.url)) return false;
  try {
    await chrome.tabs.goBack(details.tabId);
  } catch {
    // No earlier entry, or tab gone — ignore.
  }
  return true;
}

// declarativeNetRequest only fires on real network requests, so SPA
// navigations within Tulip (history.pushState) bypass it. Catch those here and
// trigger a real navigation to the sorted URL (unless it's a Back/Forward into
// the un-sorted duplicate, which skipSortDuplicate handles).
async function onSpaNavigation(details) {
  if (details.frameId !== 0) return;
  if (await skipSortDuplicate(details)) return;
  const toggles = await getToggles();
  if (!toggles[TABLE_FEATURE_ID]) return;
  const m = details.url.match(TABLE_URL_RE);
  if (!m) return;
  try {
    await chrome.tabs.update(details.tabId, {
      url: `https://${m[1]}.tulip.co${m[2]}?${SORT_QUERY}`,
    });
  } catch {
    // Tab may have closed or navigated again — ignore.
  }
}

// Seed storage with toggle defaults before anything reads it, so content
// scripts can treat storage as the single source of truth. onInstalled also
// fires on extension update, which is how newly shipped toggles get seeded.
async function init() {
  await seedDefaults();
  await syncRules();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) syncRules();
});
chrome.webNavigation.onHistoryStateUpdated.addListener(onSpaNavigation, TABLE_NAV_FILTER);
// Cross-document Back/Forward (e.g. from the sorted full-load entry back to the
// un-sorted SPA entry) only surfaces here, not in onHistoryStateUpdated.
chrome.webNavigation.onCommitted.addListener(skipSortDuplicate, TABLE_NAV_FILTER);
