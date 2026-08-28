// Adds a "Paste trigger" button to each app-level and step-level trigger list
// section in the app editor, so a copied trigger can land on a surface Tulip's
// own Ctrl+V cannot reach.
//
// Why a button rather than a shortcut: Tulip's paste dispatcher picks its
// destination from the copied trigger's OWN binding — a trigger carrying
// neither stepId nor widgetId goes to the app level, one carrying stepId goes
// to the current step, one carrying widgetId goes to the selected widget. So
// there is no way to aim Ctrl+V at "the Timers list of this step": the button
// is what names the destination. Clicking it rewrites the payload's binding to
// that section's event class and hands it to Tulip's own paste path (see
// paste-trigger-anywhere-main.js), which creates the trigger server-side and
// opens the trigger editor exactly as a native paste does.
//
// This half only owns the buttons and the toggle lifecycle; it mirrors the
// toggle to <html data-tulbelt-pta-enabled> for the main-world half, which is
// where the clipboard payload can actually be seen.
//
// Sections come in two kinds. App- and step-level lists have fixed headings, so
// this half names their event outright. Anything else is a widget or custom
// widget panel: those sections carry their own event and the destination
// widget's id in React props, invisible from this world, so they are marked
// "auto" and the main-world half reads them at click time. That is what makes
// the feature general — a component type or custom widget nobody has built yet
// works the same way, with nothing keyed to a type or a heading string.
//
// A widget with a single event — a button — renders no section headings at all,
// so its panel gets one button beside the "Triggers" heading instead, next to
// Tulip's own "+". That panel names no event, which is exactly right: it pastes
// as a generic widget event and Tulip re-derives the component's real one.
//
// "Machines & devices" pastes with its device pickers unset, for the user to
// choose in the editor that opens — Tulip's codec wants the `driver` and
// `event` KEYS present, not meaningful values, so an empty pairing validates
// where an empty object does not.

(() => {
  const { addedNodesObserver, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "paste-trigger-anywhere";
  const STORAGE_KEY = "toggles";

  const ENABLED_ATTR = "data-tulbelt-pta-enabled";
  const BUTTON_ATTR = "data-tulbelt-pta-paste";
  const STEP_ATTR = "data-tulbelt-pta-step";
  const CLAIMED_ATTR = "data-tulbelt-pta-claimed";
  const GROUP_MARK = "data-tulbelt-pta-group";
  const STYLE_ID = "tulbelt-paste-trigger-anywhere-styles";
  const RESULT_EVENT = "tulbelt:pta-result";

  // App version editor pages only (same shape as snap-to-grid).
  const EDITOR_PATH = /(?:\/w\/[^/]+)?\/apps\/[^/]+\/versions\//;

  // Tulip's own CSS-module class names; readable, not hashed.
  const GROUP_SEL = '[class*="triggerGroupStyles"]';
  const HEADING_SEL = '[class*="triggerHeaderLabel"]';

  // The context pane's whole Triggers section, and the "+" beside its heading.
  // Both are testids rather than the hashed styled-component classes around
  // them, so they are the stable hooks for a panel that has no sections at all.
  const SECTION_SEL = '[data-testid="triggers section"]';
  const ADD_BUTTON_SEL = '[data-testid="context-pane-add-trigger"]';

  // Section heading -> the event type a trigger must carry to land there.
  // Only destinations with an observed payload are listed.
  const DESTINATIONS = {
    "app started": "app-start",
    "app completed": "app-complete",
    "app cancelled": "app-cancel",
    "app canceled": "app-cancel",
    "on step enter": "step-open",
    "on step exit": "step-closed",
    timers: "interval",
    "machines & devices": "device-output",
    "machines and devices": "device-output",
  };

  // Which destinations need the current step's id in the payload to classify
  // as step-level. App-class destinations carry no ids at all.
  const STEP_CLASS = new Set(["step-open", "step-closed", "interval", "device-output"]);

  // The headings above that belong to a step. Used to tell a genuinely unknown
  // heading (a widget panel — resolve it at click time) from a known step
  // heading whose step id we could not find (offer nothing rather than paste
  // into the wrong step).
  const STEP_CLASS_HEADINGS = new Set(
    Object.keys(DESTINATIONS).filter((h) => STEP_CLASS.has(DESTINATIONS[h])),
  );

  // Tulip's own icon buttons are a bare 19px Material glyph on a transparent
  // background (see the "+" this sits beside), so match that rather than
  // introducing a bordered control into the row.
  const CSS = `
    button[${BUTTON_ATTR}] {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin: 0 2px;
      padding: 2px;
      background: transparent;
      border: 0;
      border-radius: 3px;
      color: inherit;
      font: inherit;
      font-size: 11px;
      line-height: 1;
      opacity: 0.65;
      cursor: pointer;
      vertical-align: middle;
    }
    button[${BUTTON_ATTR}]:hover { opacity: 1; }
    button[${BUTTON_ATTR}] svg { display: block; width: 19px; height: 19px; fill: currentColor; }
    button[${BUTTON_ATTR}][disabled] { cursor: default; opacity: 1; }
  `;

  // Material glyphs on the same 24x24 viewBox Tulip's own icons use.
  const ICONS = {
    paste:
      "M19 2h-4.18C14.4.84 13.3 0 12 0c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z",
    done: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  };

  const LABEL = "Paste trigger";

  function setIcon(button, kind) {
    button.textContent = "";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICONS[kind]);
    svg.appendChild(path);
    button.appendChild(svg);
  }

  function createPasteButton(type, stepId) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(BUTTON_ATTR, type);
    if (stepId) button.setAttribute(STEP_ATTR, stepId);
    // Icon-only, so the name lives in aria-label and the native tooltip.
    button.setAttribute("aria-label", LABEL);
    button.title = LABEL;
    setIcon(button, "paste");
    return button;
  }

  let active = false;
  let observer = null;

  function normalizeHeading(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/\(\d+\)\s*$/, "")
      .trim()
      .toLowerCase();
  }

  // The step whose lists are on screen. Tulip puts it in the editor URL; if it
  // isn't there we simply don't offer step-level destinations, rather than
  // guess an id and paste into the wrong place.
  function currentStepId() {
    try {
      return new URL(location.href).searchParams.get("step");
    } catch (_) {
      return null;
    }
  }

  function destinationFor(group) {
    const heading = group.querySelector(HEADING_SEL);
    if (!heading) return null;
    const type = DESTINATIONS[normalizeHeading(heading.textContent)];
    if (!type) return null;
    if (STEP_CLASS.has(type)) {
      const stepId = currentStepId();
      return stepId ? { type, stepId, heading } : null;
    }
    return { type, stepId: null, heading };
  }

  function addButton(group) {
    if (group.getAttribute(CLAIMED_ATTR) === "1") return;
    const heading = group.querySelector(HEADING_SEL);
    if (!heading) return;
    const destination = destinationFor(group);

    // A heading we don't recognize is a widget or custom-widget panel. Those
    // sections name their own event and the destination widget's id lives only
    // in React props, so they are marked "auto" and the main-world half
    // resolves them at click time — which is what makes this work for any
    // component and any custom widget, including ones that don't exist yet.
    // The exception is a heading we DO recognize as step-level but whose step
    // id we couldn't find: offering that would paste into the wrong step.
    if (!destination && STEP_CLASS_HEADINGS.has(normalizeHeading(heading.textContent))) return;

    const type = destination ? destination.type : "auto";
    const stepId = destination ? destination.stepId : null;

    group.setAttribute(CLAIMED_ATTR, "1");
    group.setAttribute(GROUP_MARK, "1");

    // The main-world half listens for clicks on this element directly — the
    // DOM is shared between worlds even though the JS environments are not.
    heading.appendChild(createPasteButton(type, stepId));
  }

  // A widget with a single event — a button — has no section headings to hang a
  // button off, so its panel gets one beside the "Triggers" heading instead.
  // Only when the panel really has no sections: where sections exist they each
  // carry their own button and a header one would be ambiguous.
  function addPanelButton(section) {
    if (section.getAttribute(CLAIMED_ATTR) === "1") return;
    if (section.querySelector(GROUP_SEL)) return;
    const addButtonEl = section.querySelector(ADD_BUTTON_SEL);
    if (!addButtonEl) return;

    section.setAttribute(CLAIMED_ATTR, "1");
    section.setAttribute(GROUP_MARK, "1");

    // "auto": the main-world half reads the widget's id from React props at
    // click time. A flat panel names no event, so it pastes as a generic
    // widget event and Tulip re-derives the real one from the component.
    const button = createPasteButton("auto", null);
    const host = addButtonEl.closest("[data-istarget]") || addButtonEl;
    host.parentElement.insertBefore(button, host);
  }

  function scan() {
    if (!active) return;
    for (const group of document.querySelectorAll(GROUP_SEL)) addButton(group);
    for (const section of document.querySelectorAll(SECTION_SEL)) addPanelButton(section);
  }

  function removeButtons() {
    for (const el of document.querySelectorAll("[" + BUTTON_ATTR + "]")) el.remove();
    for (const el of document.querySelectorAll("[" + CLAIMED_ATTR + "]")) {
      el.removeAttribute(CLAIMED_ATTR);
    }
    for (const el of document.querySelectorAll("[" + GROUP_MARK + "]")) {
      el.removeAttribute(GROUP_MARK);
    }
  }

  // The main-world half reports back here so the button can say what happened
  // without us needing a toast of our own.
  function onResult(e) {
    let detail = null;
    try {
      detail = typeof e.detail === "string" ? JSON.parse(e.detail) : null;
    } catch (_) {}
    const button = e.target && e.target.nodeType === 1 ? e.target : null;
    if (!detail || !button || !button.hasAttribute(BUTTON_ATTR)) return;
    button.disabled = true;
    if (detail.ok) {
      button.title = "Pasted";
      setIcon(button, "done");
    } else {
      // An icon can't carry a reason, and a tooltip the user has to hover for
      // is no use for something that just happened — so a refusal shows its
      // text and reverts to the icon.
      const message = detail.error || "Paste failed";
      button.title = message;
      button.textContent = message;
    }
    setTimeout(() => {
      button.title = LABEL;
      setIcon(button, "paste");
      button.disabled = false;
    }, 2200);
  }

  function enable() {
    if (active) return;
    active = true;
    ensureStyles(STYLE_ID, CSS);
    document.addEventListener(RESULT_EVENT, onResult, true);
    observer = addedNodesObserver(GROUP_SEL + ", " + SECTION_SEL, scan);
    observer.start();
    scan();
  }

  function disable() {
    if (!active) return;
    active = false;
    observer?.stop();
    observer = null;
    document.removeEventListener(RESULT_EVENT, onResult, true);
    removeButtons();
    removeStyles(STYLE_ID);
  }

  function setFlag(on) {
    try {
      document.documentElement.setAttribute(ENABLED_ATTR, on ? "true" : "false");
    } catch (_) {}
  }

  // Read raw storage rather than using registerToggle: this also has to mirror
  // the state to <html> for the main-world half and re-check the editor path.
  async function syncFromStorage() {
    let stored = {};
    try {
      const raw = await chrome.storage.local.get(STORAGE_KEY);
      if (raw && typeof raw[STORAGE_KEY] === "object") stored = raw[STORAGE_KEY];
    } catch (_) {
      return;
    }
    const next = stored[FEATURE_ID] === true && EDITOR_PATH.test(location.pathname);
    setFlag(next);
    if (next) enable();
    else disable();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) syncFromStorage();
  });

  // The editor is a single-page app: the step (and therefore the step id the
  // buttons carry) changes without a reload.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (active) removeButtons();
    syncFromStorage();
  }, 700);

  syncFromStorage();
})();
