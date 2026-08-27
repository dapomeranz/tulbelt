// Trigger-editor Value Picker inputs (`input[aria-label="Value Picker"]`) are
// a fixed ~175px line, so long static values get clipped and the only way to
// read one is to click in and arrow through.
//
// Two read-side fixes, neither of which touches the value:
//   1. Widen the input in place — `field-sizing: content` grows it to its own
//      text, the fixed-width wrapper around it is released so the input can
//      actually use the space, and both are capped at the row width. Short
//      values keep the stock width via a min-width floor, so anything that
//      already fits looks untouched.
//   2. For values still too long for the row, a hover tooltip carrying the
//      full text, set from `title` at mouseover time.
//
// Deliberately read-only, and it must stay that way. An earlier version hid
// the real input and rendered an editable <textarea> proxy in its place so
// long values could soft-wrap onto several lines — the only way to get
// wrapping at all, since `input[type=text]` cannot wrap by spec. That design
// had to forward every keystroke back into the hidden input, and those writes
// never reached Tulip's saved trigger: edits made in the proxy were silently
// dropped on save, while edits typed into the stock input saved fine. Here the
// real input remains the one and only source of truth, so there is no save
// path to break.

(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "trigger-value-full-text";
  const STYLE_ID = "tulbelt-trigger-value-full-text-styles";
  // Marks a title as ours, so disable restores exactly what we changed and a
  // title Tulip set itself is never clobbered.
  const TITLED_ATTR = "data-tulbelt-fulltext-title";

  // Tulip's stock width for these inputs, used as a floor: the toggle should
  // only ever add width, never take it away, so a value that already fits
  // renders exactly as it does with the toggle off.
  const STOCK_WIDTH = "175px";

  // Scoped to the trigger editor by Tulip's CSS-module class prefix, so
  // look-alike inputs elsewhere in the app are left alone.
  const SCOPE = '[class*="triggers-editor-client"]';
  const INPUT = 'input[type="text"][aria-label="Value Picker"]';

  // `field-sizing: content` is Chrome 123+. Where it is unsupported the
  // declaration is simply dropped and the input keeps its default intrinsic
  // width — no JS fallback, and nothing that can throw.
  const CSS = `
      ${SCOPE} ${INPUT} {
        field-sizing: content;
        width: auto !important;
        min-width: ${STOCK_WIDTH};
        max-width: 100% !important;
      }
      /* The input lives in a fixed-width wrapper; without releasing that too,
         the input can only ever grow to the wrapper's edge. */
      ${SCOPE} :has(> ${INPUT}) {
        width: auto !important;
        max-width: 100% !important;
      }
    `;

  function clearTitle(el) {
    el.removeAttribute("title");
    el.removeAttribute(TITLED_ATTR);
  }

  // Built at hover time rather than kept in sync: the value is read straight
  // off the input at the moment it is needed, so the tooltip can never go
  // stale and nothing has to observe the field.
  function onMouseOver(e) {
    const el = e.target;
    if (!(el instanceof Element) || !el.matches(INPUT) || !el.closest(SCOPE)) return;
    // A title Tulip put there itself is not ours to replace.
    if (el.hasAttribute("title") && !el.hasAttribute(TITLED_ATTR)) return;

    const value = el.value;
    // Only when the text still doesn't fit — a value the widened input already
    // shows in full doesn't need a tooltip repeating it.
    if (value && el.scrollWidth > el.clientWidth + 1) {
      if (el.getAttribute("title") !== value) {
        el.setAttribute("title", value);
        el.setAttribute(TITLED_ATTR, "1");
      }
    } else if (el.hasAttribute(TITLED_ATTR)) {
      clearTitle(el);
    }
  }

  registerToggle(FEATURE_ID, {
    onEnable() {
      ensureStyles(STYLE_ID, CSS);
      document.addEventListener("mouseover", onMouseOver, true);
    },
    onDisable() {
      document.removeEventListener("mouseover", onMouseOver, true);
      document.querySelectorAll(`[${TITLED_ATTR}]`).forEach(clearTitle);
      removeStyles(STYLE_ID);
    },
  });
})();
