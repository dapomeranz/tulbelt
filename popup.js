import { FEATURES, getToggles, setToggle } from './features.js';

const template = document.createElement('template');
template.innerHTML = `
  <li class="feature">
    <label>
      <div class="feature-text">
        <span class="feature-name"></span>
        <span class="feature-desc"></span>
      </div>
      <span class="switch">
        <input type="checkbox" />
        <span class="slider"></span>
      </span>
    </label>
  </li>
`;

async function render() {
  const toggles = await getToggles();
  const list = document.getElementById('toggles');
  list.replaceChildren();

  for (const feature of FEATURES) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector('.feature-name').textContent = feature.name;
    node.querySelector('.feature-desc').textContent = feature.description;
    const cb = node.querySelector('input');
    cb.checked = toggles[feature.id];
    cb.addEventListener('change', () => setToggle(feature.id, cb.checked));
    list.appendChild(node);
  }
}

render();
