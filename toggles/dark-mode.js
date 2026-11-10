// Applies a dark color scheme to tulip.co via filter-inversion. The whole
// document uses invert + contrast + brightness on <html> (no hue-rotate) so
// restored subtrees can fully cancel with the inverse chain and stay
// hue-faithful. Targeted color tweaks go at the end of DARK_CSS and are
// specified in inverted space (the literal color the html filter will flip
// into the final shade).
//
// Inverting also flips hue, which breaks any color that carries meaning: a red
// Delete button turns cyan, a yellow warning turns navy, and Tulip's blue accent
// turns amber. Those elements have only hashed class names and rarely a test id,
// so CSS can't select them. They're found by computed color instead and given a
// hue-only correction, which keeps them dark.
//
// Runs at document_start, ahead of every other toggle, so the page is dark from
// its first paint instead of flashing light until document_idle.

(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "dark-mode";
  const ROOT_CLASS = "tulbelt-dark";
  const STYLE_ID = "tulbelt-dark-styles";
  const HUE_ATTR = "data-tulbelt-dark-hue";

  const HUE_FIX_FILTER = "hue-rotate(180deg)";
  const CHART = ".recharts-wrapper";

  // Containers restored as a whole. Anything inside one is already back to its
  // original colors, so it must not be restored or corrected a second time.
  const RESTORED_REGIONS = ["#player-process-container", '#cssCanvas [data-testid="widget"]'];

  // Elements restored on their own, wherever they sit.
  const RESTORED_ELEMENTS = [
    "img",
    "video",
    "iframe",
    "canvas",
    "div:has(> .saturation-white)",
    ".hue-horizontal",
    ".hue-vertical",
    '[data-testid="color-picker-thumb"]',
    '[data-istarget="true"][style*="background-color"][style*="width: 16px"][style*="height: 16px"]',
    "#editor-border",
  ];

  // Floating surfaces had a shadow as their only edge, so without one a menu
  // blends into the page behind it.
  const FLOATING_SURFACES = ['[data-testid="popper"] > div', '[role="menu"]', '[role="listbox"]'];

  const PAGE_CONTRAST = 0.73;
  const PAGE_BRIGHTNESS = 1.16;
  const PAGE_FILTER = `invert(1) contrast(${PAGE_CONTRAST}) brightness(${PAGE_BRIGHTNESS})`;
  const RESTORE_FILTER = [
    `brightness(${(1 / PAGE_BRIGHTNESS).toFixed(4)})`,
    `contrast(${(1 / PAGE_CONTRAST).toFixed(4)})`,
    "invert(1)",
  ].join(" ");

  const scoped = (selectors) => selectors.map((s) => `html.${ROOT_CLASS} ${s}`).join(",\n  ");

  const OUTSIDE_RESTORED = `:not(${RESTORED_REGIONS.flatMap((r) => [r, `${r} *`]).join(", ")})`;

  const DARK_CSS = `
  html.${ROOT_CLASS} {
    filter: ${PAGE_FILTER};
    background: #fff;
  }

  /* Filters apply to the whole painted output of each subtree, so box-shadow /
     text-shadow get inverted into harsh light halos. There is no way to "keep"
     a shadow un-inverted while <html> is filtered; strip them instead. Restored
     regions are the exception: their shadows are put back with everything else,
     and they belong to whoever built the app. */
  html.${ROOT_CLASS} *${OUTSIDE_RESTORED},
  html.${ROOT_CLASS} *${OUTSIDE_RESTORED}::before,
  html.${ROOT_CLASS} *${OUTSIDE_RESTORED}::after {
    box-shadow: none !important;
    text-shadow: none !important;
  }

  /* Restore regions that should keep their original colors. CSS filters compose
     parent-after-child, so this child filter is the page filter's inverse. */
  ${scoped([...RESTORED_REGIONS, ...RESTORED_ELEMENTS])} {
    filter: ${RESTORE_FILTER};
  }

  /* Media inside a restored region would otherwise be restored twice, which
     inverts it again. Custom widgets render in an iframe, so this is what keeps
     them looking the way they do with dark mode off. */
  ${scoped(RESTORED_REGIONS.map((region) => `${region} :is(img, video, iframe, canvas)`))},
  html.${ROOT_CLASS} #cssCanvas canvas {
    filter: none;
  }

  /* Hue only, so these stay dark but red still reads as red. A chart is corrected
     as a whole because every one of its colors is data, blue included. */
  html.${ROOT_CLASS} [${HUE_ATTR}],
  html.${ROOT_CLASS} ${CHART}${OUTSIDE_RESTORED} {
    filter: ${HUE_FIX_FILTER};
  }

  /* A black scrim inverts to white and would brighten the page behind a dialog.
     White inverts back to black, so this dims it as it does in light mode. */
  html.${ROOT_CLASS} [data-testid="modal-overlay"],
  html.${ROOT_CLASS} [data-testid="underlay"] {
    background-color: rgba(255, 255, 255, 0.45) !important;
  }

  /* Bootstrap's backdrop, used by the trigger editor, gets its dimming from opacity. */
  html.${ROOT_CLASS} .modal-backdrop {
    background-color: #fff !important;
  }

  ${scoped(FLOATING_SURFACES)} {
    outline: 1px solid #cacaca;
  }

  /* The account logo is restored, and a dark logo on a transparent background
     would vanish against the dark header, so give it the white it was made for.
     Avatars are opaque, so this doesn't show on them. */
  html.${ROOT_CLASS} [data-testid="tulip-header"] img {
    background: #fff;
  }
`;

  // A faint tint is enough for a background (Tulip's status tints are close to
  // white). Foregrounds need more: its body text is a dark navy with some chroma,
  // which should stay inverted, since correcting every line of text would be a
  // filter on nearly every element.
  const MIN_BACKGROUND_CHROMA = 5;
  const MIN_BACKGROUND_SATURATION = 0.25;
  const MIN_FOREGROUND_CHROMA = 60;
  const MIN_BORDER_CHROMA = 30;
  const MIN_ALPHA = 0.5;
  const MAX_ICON_PX = 48;
  // A filter makes its element a stacking context and containing block, which is
  // only safe on something small enough not to host a popper of its own.
  const MAX_DESCENDANTS = 60;

  const SCANNED =
    "div, span, button, a, p, li, label, h1, h2, h3, h4, svg, input, textarea, select";
  // Hover and focus colors change no class, so these are re-checked by hand. The
  // ring or highlight is often on a wrapper rather than the event's target.
  const INTERACTION_EVENTS = ["mouseover", "mouseout", "focusin", "focusout"];
  const INTERACTION_ANCESTORS = 3;
  const SKIP = [...RESTORED_REGIONS, ...RESTORED_ELEMENTS, CHART].join(", ");

  function parseColor(value) {
    if (!value.startsWith("rgb")) return null;
    const [r, g, b, alpha = 1] = value.match(/[\d.]+/g).map(Number);
    if (alpha < MIN_ALPHA) return null;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    const lightness = (max + min) / 510;
    const saturation = chroma ? chroma / 255 / (1 - Math.abs(2 * lightness - 1)) : 0;
    return { chroma, saturation };
  }

  function isTinted(value) {
    const color = parseColor(value);
    return (
      color !== null &&
      color.chroma >= MIN_BACKGROUND_CHROMA &&
      color.saturation >= MIN_BACKGROUND_SATURATION
    );
  }

  function isMeaningfulForeground(value) {
    const color = parseColor(value);
    return color !== null && color.chroma >= MIN_FOREGROUND_CHROMA;
  }

  // A focus ring, or a red outline on a field that failed validation.
  function hasMeaningfulBorder(style) {
    if (parseFloat(style.borderTopWidth) === 0) return false;
    const color = parseColor(style.borderTopColor);
    return color !== null && color.chroma >= MIN_BORDER_CHROMA;
  }

  function hasOwnText(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return true;
    }
    return false;
  }

  function iconHasMeaningfulColor(svg, style) {
    const box = svg.getBoundingClientRect();
    if (box.width > MAX_ICON_PX || box.height > MAX_ICON_PX) return false;
    const shape = svg.querySelector("path, circle, rect, polygon");
    const fill = shape ? getComputedStyle(shape).fill : style.fill;
    return isMeaningfulForeground(fill);
  }

  function hasMeaningfulColor(el) {
    const style = getComputedStyle(el);
    if (el.tagName === "svg") return iconHasMeaningfulColor(el, style);
    return (
      isTinted(style.backgroundColor) ||
      hasMeaningfulBorder(style) ||
      (hasOwnText(el) && isMeaningfulForeground(style.color))
    );
  }

  function needsHueFix(el) {
    return (
      hasMeaningfulColor(el) &&
      el.getElementsByTagName("*").length <= MAX_DESCENDANTS &&
      !el.closest(SKIP) &&
      !el.parentElement.closest(`[${HUE_ATTR}]`)
    );
  }

  // Corrections must not nest, or two rotations would cancel out. Marking an
  // element takes over from any marked descendants; unmarking hands back to them.
  function checkHue(el) {
    const wanted = needsHueFix(el);
    const marked = el.hasAttribute(HUE_ATTR);
    if (wanted === marked) return;
    el.toggleAttribute(HUE_ATTR, wanted);
    if (wanted) {
      for (const inner of el.querySelectorAll(`[${HUE_ATTR}]`)) inner.removeAttribute(HUE_ATTR);
    } else {
      for (const inner of el.querySelectorAll(SCANNED)) checkHue(inner);
    }
  }

  function scanSubtree(root) {
    if (root.matches(SCANNED)) checkHue(root);
    for (const el of root.querySelectorAll(SCANNED)) checkHue(el);
  }

  // Added subtrees get a full scan. A class change, finished transition, or
  // interaction only re-checks that element, since a live status flips color in
  // place.
  const pendingSubtrees = new Set();
  const pendingElements = new Set();
  let frame = 0;
  let observer = null;
  let enabled = false;

  function flush() {
    frame = 0;
    for (const root of pendingSubtrees) if (root.isConnected) scanSubtree(root);
    for (const el of pendingElements) if (el.isConnected) checkHue(el);
    pendingSubtrees.clear();
    pendingElements.clear();
  }

  function scheduleFlush() {
    if (!frame) frame = requestAnimationFrame(flush);
  }

  function onMutations(mutations) {
    for (const m of mutations) {
      if (m.type === "attributes") {
        if (m.target.matches(SCANNED)) pendingElements.add(m.target);
        continue;
      }
      for (const node of m.addedNodes) {
        if (node instanceof Element) pendingSubtrees.add(node);
      }
    }
    if (pendingSubtrees.size || pendingElements.size) scheduleFlush();
  }

  function onTransitionEnd(event) {
    if (event.target instanceof Element && event.target.matches(SCANNED)) {
      pendingElements.add(event.target);
      scheduleFlush();
    }
  }

  function onInteraction(event) {
    let el = event.target;
    for (let i = 0; i <= INTERACTION_ANCESTORS && el instanceof Element; i++) {
      if (el.matches(SCANNED)) pendingElements.add(el);
      el = el.parentElement;
    }
    scheduleFlush();
  }

  function startHueWatch() {
    if (!enabled || observer) return;
    scanSubtree(document.body);
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    document.addEventListener("transitionend", onTransitionEnd, true);
    for (const type of INTERACTION_EVENTS) document.addEventListener(type, onInteraction, true);
  }

  function stopHueWatch() {
    observer?.disconnect();
    observer = null;
    document.removeEventListener("transitionend", onTransitionEnd, true);
    for (const type of INTERACTION_EVENTS) document.removeEventListener(type, onInteraction, true);
    cancelAnimationFrame(frame);
    frame = 0;
    pendingSubtrees.clear();
    pendingElements.clear();
    for (const el of document.querySelectorAll(`[${HUE_ATTR}]`)) el.removeAttribute(HUE_ATTR);
  }

  registerToggle(FEATURE_ID, {
    onEnable() {
      enabled = true;
      ensureStyles(STYLE_ID, DARK_CSS);
      document.documentElement.classList.add(ROOT_CLASS);
      if (document.body) startHueWatch();
      else document.addEventListener("DOMContentLoaded", startHueWatch, { once: true });
    },
    onDisable() {
      enabled = false;
      stopHueWatch();
      document.documentElement.classList.remove(ROOT_CLASS);
      removeStyles(STYLE_ID);
    },
  });
})();
