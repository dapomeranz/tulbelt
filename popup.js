import { getPopupFeatureGroups, getToggles, setToggle } from './features.js';

const featureTemplate = document.createElement('template');
featureTemplate.innerHTML = `
  <li class="feature">
    <label>
      <span class="feature-name"></span>
      <span class="switch">
        <input type="checkbox" />
        <span class="slider"></span>
      </span>
    </label>
  </li>
`;

const sectionTemplate = document.createElement('template');
sectionTemplate.innerHTML = `
  <li class="feature-section"><span class="feature-section-label"></span></li>
`;

const tooltip = document.getElementById('tooltip');
const SHOW_DELAY_MS = 150;
let showTimer = null;

function positionTooltip(anchor) {
  const rect = anchor.getBoundingClientRect();
  const margin = 6;
  const inset = 10;
  const tipRect = tooltip.getBoundingClientRect();
  const alignRight = anchor.closest('.header-links');

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

function bindTooltip(label, text) {
  label.addEventListener('mouseenter', () => showTooltip(text, label));
  label.addEventListener('mouseleave', hideTooltip);
  label.addEventListener('focusin', () => showTooltip(text, label));
  label.addEventListener('focusout', hideTooltip);
}

function createSectionNode(title, sectionId) {
  const node = sectionTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector('.feature-section-label').textContent = title;
  node.dataset.section = sectionId;
  return node;
}

function createFeatureNode(feature, enabled, sectionId) {
  const node = featureTemplate.content.firstElementChild.cloneNode(true);
  const label = node.querySelector('label');
  node.querySelector('.feature-name').textContent = feature.name;
  node.dataset.featureId = feature.id;
  node.dataset.search = `${feature.name} ${feature.description}`.toLowerCase();
  node.dataset.section = sectionId;
  bindTooltip(label, feature.description);
  const cb = node.querySelector('input');
  cb.checked = enabled;
  cb.addEventListener('change', () => setToggle(feature.id, cb.checked));
  return node;
}

function buildPopupFeatures(toggles) {
  const { major, more } = getPopupFeatureGroups();
  const items = [];

  if (major.length) {
    items.push(createSectionNode('Major', 'major'));
    for (const feature of major) {
      items.push(createFeatureNode(feature, toggles[feature.id], 'major'));
    }
  }

  if (more.length) {
    items.push(createSectionNode('More', 'more'));
    for (const feature of more) {
      items.push(createFeatureNode(feature, toggles[feature.id], 'more'));
    }
  }

  return items;
}

function filterFeatures(query, list, noResults) {
  const q = query.trim().toLowerCase();
  let visibleFeatures = 0;

  hideTooltip();

  for (const node of list.querySelectorAll('.feature')) {
    const show = !q || node.dataset.search.includes(q);
    node.hidden = !show;
    if (show) visibleFeatures++;
  }

  for (const section of list.querySelectorAll('.feature-section')) {
    const sectionId = section.dataset.section;
    const hasVisible = [...list.querySelectorAll(`.feature[data-section="${sectionId}"]`)].some(
      (node) => !node.hidden,
    );
    section.hidden = !hasVisible;
  }

  noResults.hidden = visibleFeatures > 0;
  list.hidden = visibleFeatures === 0;
}

async function render() {
  const toggles = await getToggles();
  const list = document.getElementById('toggles');
  const search = document.getElementById('feature-search');
  const noResults = document.getElementById('no-results');

  list.replaceChildren(...buildPopupFeatures(toggles));

  search.addEventListener('input', () =>
    filterFeatures(search.value, list, noResults),
  );

  document.addEventListener('scroll', hideTooltip, true);

  for (const link of document.querySelectorAll('.header-links a')) {
    bindTooltip(link, link.getAttribute('aria-label'));
    link.addEventListener('click', (e) => {
      e.preventDefault();
      hideTooltip();
      chrome.tabs.create({ url: link.href });
    });
  }
}

render();
