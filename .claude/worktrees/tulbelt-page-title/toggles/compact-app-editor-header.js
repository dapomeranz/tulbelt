// Shrinks Tulip app editor chrome: hides palette button leading glyphs, the
// workspace label beside breadcrumbs, and tightens vertical padding on the
// subheader strip and palette row. One toggle drives it all.

(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "compact-app-editor-header";
  const STYLE_ID = "tulbelt-compact-app-editor-header-styles";

  const SVG_PALETTE_BUTTON_IDS = [
    "app-editor-add",
    "app-editor-icons",
    "app-editor-buttons",
    "app-editor-inputs",
    "app-editor-text",
    "app-editor-embed",
    "app-editor-camera",
    "app-editor-custom",
  ];
  const ICON_FONT_BUTTON_IDS = ["app-editor-forward", "app-editor-back"];

  function buildCss() {
    const svgSelector = SVG_PALETTE_BUTTON_IDS.map((id) => `#${id} svg[width="32"]`).join(", ");
    const iconFontSelector = ICON_FONT_BUTTON_IDS.map((id) => `#${id} .icon`).join(", ");
    const workspaceLabel = `
    [data-testid="subheader"] [data-testid="breadcrumbs"] + div {
      display: none !important;
    }
  `;
    /* #app-editor-publish limits subheader rules to app version editor toolbar.
     `#app-editor-add` sits in its own sibling row; `:has(> #app-editor-add)`
     selects that palette strip without brittle class hashes. */
    const tighterVerticalBars = `
    div:has(> [data-testid="subheader"]:has(#app-editor-publish)),
    [data-testid="subheader"]:has(#app-editor-publish),
    div:has(> #app-editor-add) {
      padding-block: 5px !important;
      row-gap: 4px !important;
      min-height: unset !important;
    }
  `;
    return `${svgSelector}, ${iconFontSelector} { display: none !important; }
${workspaceLabel}
${tighterVerticalBars}`;
  }

  registerToggle(FEATURE_ID, {
    onEnable() {
      ensureStyles(STYLE_ID, buildCss());
    },
    onDisable() {
      removeStyles(STYLE_ID);
    },
  });
})();
