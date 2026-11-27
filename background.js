import { FEATURES, STORAGE_KEY, getToggles, ruleIdFor, seedDefaults } from "./features.js";

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
