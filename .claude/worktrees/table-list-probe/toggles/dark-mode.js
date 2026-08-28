// Applies a dark color scheme to tulip.co via filter-inversion. The whole
// document uses invert + contrast + brightness on <html> (no hue-rotate) so
// restored subtrees can fully cancel with the inverse chain and stay
// hue-faithful. Targeted color tweaks go at the end of DARK_CSS and are
// specified in inverted space (the literal color the html filter will flip
// into the final shade).

(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "dark-mode";
  const ROOT_CLASS = "tulbelt-dark";
  const STYLE_ID = "tulbelt-dark-styles";

  const PAGE_CONTRAST = 0.73;
  const PAGE_BRIGHTNESS = 1.16;
  const PAGE_FILTER = `invert(1) contrast(${PAGE_CONTRAST}) brightness(${PAGE_BRIGHTNESS})`;
  const RESTORE_FILTER = [
    `brightness(${(1 / PAGE_BRIGHTNESS).toFixed(4)})`,
    `contrast(${(1 / PAGE_CONTRAST).toFixed(4)})`,
    "invert(1)",
  ].join(" ");

  const DARK_CSS = `
  html.${ROOT_CLASS} {
    filter: ${PAGE_FILTER};
    background: #fff;
  }

  /* Filters apply to the whole painted output of each subtree, so box-shadow /
     text-shadow get inverted into harsh light halos. There is no way to "keep"
     a shadow un-inverted while <html> is filtered; strip them instead. */
  html.${ROOT_CLASS} *,
  html.${ROOT_CLASS} *::before,
  html.${ROOT_CLASS} *::after {
    box-shadow: none !important;
    text-shadow: none !important;
  }

  /* Restore regions that should keep their original colors. CSS filters compose
     parent-after-child, so this child filter is the page filter's inverse. */
  html.${ROOT_CLASS} #tulip-header,
  html.${ROOT_CLASS} .imports-components-StationPreview-StationPreview--containerStyles,
  html.${ROOT_CLASS} .station-preview-wrapper,
  html.${ROOT_CLASS} #player-process-container,
  html.${ROOT_CLASS} img,
  html.${ROOT_CLASS} video,
  html.${ROOT_CLASS} iframe,
  html.${ROOT_CLASS} canvas:not(#cssCanvas canvas),
  html.${ROOT_CLASS} div:has(> .saturation-white),
  html.${ROOT_CLASS} .hue-horizontal,
  html.${ROOT_CLASS} .hue-vertical,
  html.${ROOT_CLASS} [data-testid="color-picker-thumb"],
  html.${ROOT_CLASS} [data-istarget="true"][style*="background-color"][style*="width: 16px"][style*="height: 16px"],
  html.${ROOT_CLASS} #editor-border,
  html.${ROOT_CLASS} #cssCanvas [data-testid="widget"] {
    filter: ${RESTORE_FILTER};
  }

  html.${ROOT_CLASS} .imports-components-StationPreview-StationPreview--containerStyles img,
  html.${ROOT_CLASS} .station-preview-wrapper img,
  html.${ROOT_CLASS} #player-process-container img,
  html.${ROOT_CLASS} #cssCanvas [data-testid="widget"] img {
    filter: none;
  }
`;

  registerToggle(FEATURE_ID, {
    onEnable() {
      ensureStyles(STYLE_ID, DARK_CSS);
      document.documentElement.classList.add(ROOT_CLASS);
    },
    onDisable() {
      document.documentElement.classList.remove(ROOT_CLASS);
      removeStyles(STYLE_ID);
    },
  });
})();
