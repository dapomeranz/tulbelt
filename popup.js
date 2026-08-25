import {
  getDeveloperMode,
  getPopupFeatures,
  getToggles,
  setDeveloperMode,
  setToggle,
  setToggles,
} from "./features.js";

const DEV_MODE_CLICKS = 5;
const DEV_MODE_CLICK_WINDOW_MS = 2000;

const featureTemplate = document.createElement("template");
featureTemplate.innerHTML = `
  <li class="feature">
    <label>
      <span class="feature-name"></span>
      <span class="feature-controls">
        <span class="feature-info" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 16 16">
            <path
              fill="currentColor"
              d="M8 1.25a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5Zm0 1.3a5.45 5.45 0 1 0 0 10.9 5.45 5.45 0 0 0 0-10.9ZM8 4.1a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Zm-.75 2.85h1.5v4.7h-1.5v-4.7Z"
            />
          </svg>
        </span>
        <span class="switch">
          <input type="checkbox" aria-describedby="tooltip" />
          <span class="slider"></span>
        </span>
      </span>
    </label>
  </li>
`;

const tooltip = document.getElementById("tooltip");
const SHOW_DELAY_MS = 150;
let showTimer = null;

function positionTooltip(anchor) {
  const rect = anchor.getBoundingClientRect();
  const margin = 6;
  const inset = 10;
  const tipRect = tooltip.getBoundingClientRect();
  const alignRight = anchor.closest(".header-links");

  let top = rect.bottom + margin;
  if (top + tipRect.height > window.innerHeight - inset) {
    top = rect.top - tipRect.height - margin;
  }

  tooltip.style.top = `${Math.max(inset, top)}px`;
  if (alignRight) {
    const maxLeft = window.innerWidth - tipRect.width - inset;
    const left = Math.max(inset, Math.min(rect.right - tipRect.width, maxLeft));
    tooltip.style.left = `${left}px`;
  } else {
    tooltip.style.left = `${inset}px`;
  }
}

function showTooltip(text, anchor) {
  clearTimeout(showTimer);
  const reveal = () => {
    tooltip.textContent = text;
    tooltip.hidden = false;
    positionTooltip(anchor);
  };
  if (!tooltip.hidden) reveal();
  else showTimer = setTimeout(reveal, SHOW_DELAY_MS);
}

function hideTooltip() {
  clearTimeout(showTimer);
  tooltip.hidden = true;
}

function bindHoverTooltip(anchor, text) {
  anchor.addEventListener("mouseenter", () => showTooltip(text, anchor));
  anchor.addEventListener("mouseleave", hideTooltip);
  anchor.addEventListener("focusin", () => showTooltip(text, anchor));
  anchor.addEventListener("focusout", hideTooltip);
}

// The icon is a plain <span> on purpose: a <button> here would be the first
// labelable element inside the row's <label> and would steal the clicks meant
// for the checkbox, leaving the switch dead.
function bindInfoIcon(icon, checkbox, description) {
  icon.addEventListener("mouseenter", () => showTooltip(description, icon));
  icon.addEventListener("mouseleave", hideTooltip);
  // Reading the description shouldn't flip the feature: cancel the click so the
  // surrounding label doesn't forward it to the checkbox.
  icon.addEventListener("click", (event) => event.preventDefault());
  // Keyboard users never hover, so give them the same text off the switch's
  // focus — anchored to the icon either way. :focus-visible keeps this to
  // keyboard focus, so clicking a row doesn't pop the tooltip.
  checkbox.addEventListener("focus", () => {
    if (checkbox.matches(":focus-visible")) showTooltip(description, icon);
  });
  checkbox.addEventListener("blur", hideTooltip);
}

function createFeatureNode(feature, enabled) {
  const node = featureTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".feature-name").textContent = feature.name;
  node.dataset.featureId = feature.id;
  node.dataset.search = `${feature.name} ${feature.description}`.toLowerCase();
  const cb = node.querySelector("input");
  bindInfoIcon(node.querySelector(".feature-info"), cb, feature.description);
  cb.checked = enabled;
  cb.addEventListener("change", () => setToggle(feature.id, cb.checked));
  return node;
}

function buildPopupFeatures(toggles, showDeveloperFeatures) {
  return getPopupFeatures({ showDeveloperFeatures }).map((feature) =>
    createFeatureNode(feature, toggles[feature.id]),
  );
}

// Only ever runs with the list unfiltered (the links hide during a search), so
// this is every row the popup is showing — which can never include a
// developer-only feature, as those aren't rendered outside developer mode.
function setAll(list, enabled) {
  const updates = {};
  for (const node of list.querySelectorAll(".feature")) {
    node.querySelector("input").checked = enabled;
    updates[node.dataset.featureId] = enabled;
  }
  return setToggles(updates);
}

// The links read as covering the whole list, so they only show while the whole
// list is on screen — a search hides them rather than quietly narrowing them.
function syncBulkActions(bulkActions, query) {
  bulkActions.hidden = query.trim() !== "";
}

function filterFeatures(query, list, noResults) {
  const q = query.trim().toLowerCase();
  let visibleFeatures = 0;

  hideTooltip();

  for (const node of list.querySelectorAll(".feature")) {
    const show = !q || node.dataset.search.includes(q);
    node.hidden = !show;
    if (show) visibleFeatures++;
  }

  noResults.hidden = visibleFeatures > 0;
  list.hidden = visibleFeatures === 0;
}

function bindDeveloperModeUnlock(onChange) {
  const title = document.querySelector(".header-brand h1");
  if (!title) return;

  let clicks = 0;
  let resetTimer = null;

  title.addEventListener("click", async () => {
    clicks += 1;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      clicks = 0;
    }, DEV_MODE_CLICK_WINDOW_MS);

    if (clicks < DEV_MODE_CLICKS) return;
    clicks = 0;
    clearTimeout(resetTimer);

    const next = !(await getDeveloperMode());
    await setDeveloperMode(next);
    onChange(next);
  });
}

function setDeveloperModeSubtitle(enabled) {
  const subtitle = document.querySelector(".subtitle");
  if (!subtitle) return;
  subtitle.textContent = enabled ? "tulip.co tweaks · developer" : "tulip.co tweaks";
}

async function render() {
  const developerMode = await getDeveloperMode();
  const toggles = await getToggles();
  const list = document.getElementById("toggles");
  const search = document.getElementById("feature-search");
  const noResults = document.getElementById("no-results");
  const bulkActions = document.querySelector(".bulk-actions");

  setDeveloperModeSubtitle(developerMode);
  list.replaceChildren(...buildPopupFeatures(toggles, developerMode));

  const applyFilter = () => {
    filterFeatures(search.value, list, noResults);
    syncBulkActions(bulkActions, search.value);
  };

  search.addEventListener("input", applyFilter);
  bulkActions.querySelector("#all-on").addEventListener("click", () => setAll(list, true));
  bulkActions.querySelector("#all-off").addEventListener("click", () => setAll(list, false));
  syncBulkActions(bulkActions, search.value);

  document.addEventListener("scroll", hideTooltip, true);

  for (const link of document.querySelectorAll(".header-links a")) {
    bindHoverTooltip(link, link.getAttribute("aria-label"));
    link.addEventListener("click", (e) => {
      e.preventDefault();
      hideTooltip();
      chrome.tabs.create({ url: link.href });
    });
  }

  bindDeveloperModeUnlock(async (enabled) => {
    setDeveloperModeSubtitle(enabled);
    const nextToggles = await getToggles();
    list.replaceChildren(...buildPopupFeatures(nextToggles, enabled));
    applyFilter();
  });
}

render();
