// Finds the ids a paste button needs in a WIDGET or CUSTOM WIDGET trigger
// panel (docs/paste-trigger-anywhere.md). Paste into the DevTools console of an
// app editor tab, page ("top") context, with the target widget SELECTED so its
// trigger list is showing in the context pane.
//
//   __widgetProbe()        → prints and stashes the report
//   copy(__widgetProbeJson)   (typed alone at the prompt)
//
// Why: pasting onto a widget needs `widgetId` in the payload, and pasting into
// a custom widget's event section needs that section's `eventName` plus the
// widget type's `customWidgetId`. App- and step-level destinations needed
// neither — the app class carries no ids and the step id is in the URL — so
// this is the last unknown blocking those two panels.
//
// It looks in four places, cheapest first:
//   1. the URL, in case selection is a query parameter like the step is
//   2. attributes on the selected canvas widget element
//   3. React fibers above the selected widget — Tulip's widget model shows up
//      in component props as `_id` / `type` / `customWidgetId`
//   4. React fibers on each trigger-list section, where a custom widget
//      section's own event descriptor should live
//
// Reads only; nothing is patched, so there is nothing to undo. The output
// contains real ids — paste it into chat or gitignored notes, never a tracked
// file.

(() => {
  const FIBER_PREFIXES = ["__reactFiber$", "__reactInternalInstance$", "__reactContainer$"];
  const INTERESTING = /^(_id|id|type|widgetType|customWidgetId|eventName|events|event|widget|name)$/;
  const MAX_DEPTH = 24;

  function fiberOf(node) {
    if (!node) return null;
    let keys;
    try {
      keys = Object.getOwnPropertyNames(node);
    } catch (_) {
      return null;
    }
    for (const k of keys) {
      for (const p of FIBER_PREFIXES) {
        if (k.startsWith(p) && node[k]) return node[k];
      }
    }
    return null;
  }

  function nameOf(fiber) {
    const t = fiber.type;
    if (typeof t === "string") return t;
    return (t && (t.displayName || t.name)) || "?";
  }

  // Tulip ids are Meteor-style: 17 characters of mixed-case alphanumerics.
  // Matching on the SHAPE of the value rather than on a key name is what keeps
  // this general — the toggle has to work for widget types nobody has built
  // yet, so a prop called something unexpected still has to be found.
  const ID_SHAPED = /^[A-Za-z0-9]{17}$/;

  // A shallow, readable view of a props object: the keys we're hunting for by
  // name, plus anything whose value looks like an id, plus a shape hint for
  // objects and arrays.
  function summarize(props) {
    const out = {};
    if (!props || typeof props !== "object") return out;
    for (const key of Object.keys(props)) {
      const value = props[key];
      if (value == null) continue;
      const named = INTERESTING.test(key);
      if (typeof value === "string") {
        if (named || ID_SHAPED.test(value)) out[key] = value;
      } else if (typeof value === "number" || typeof value === "boolean") {
        if (named) out[key] = value;
      } else if (Array.isArray(value)) {
        if (named) out[key] = "[" + value.length + "] " + JSON.stringify(value.slice(0, 3)).slice(0, 400);
      } else if (typeof value === "object") {
        const nested = JSON.stringify(value);
        // Keep an unnamed object only when it carries an id-shaped value —
        // that is how an event descriptor or a widget model announces itself.
        if (named || (nested && /"[A-Za-z0-9]{17}"/.test(nested))) {
          out[key] = nested.slice(0, 400);
        }
      }
    }
    return out;
  }

  // Climb the fiber tree collecting any component whose props mention one of
  // the keys we're hunting for.
  function climb(startNode, label) {
    const hits = [];
    let fiber = fiberOf(startNode);
    let depth = 0;
    while (fiber && depth < MAX_DEPTH) {
      const summary = summarize(fiber.memoizedProps);
      if (Object.keys(summary).length) {
        hits.push({ depth, component: nameOf(fiber), props: summary });
      }
      fiber = fiber.return;
      depth++;
    }
    return { label, hitCount: hits.length, hits };
  }

  function describe(el) {
    const attrs = {};
    for (const a of el.attributes || []) {
      if (a.value.length <= 200) attrs[a.name] = a.value;
    }
    return { tag: el.tagName, attrs };
  }

  window.__widgetProbe = () => {
    const report = { url: location.pathname + location.search, found: {} };

    // 1. the URL
    try {
      report.found.urlParams = Object.fromEntries(new URL(location.href).searchParams.entries());
    } catch (_) {}

    // 2 + 3. the selected canvas widget
    const selectors = [
      '#cssCanvas [data-testid="widget"].selected',
      "#cssCanvas .widget.selected",
      "#cssCanvas .selected",
      '[data-testid="widget"].selected',
    ];
    let selected = null;
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        selected = el;
        report.found.selectedBy = sel;
        break;
      }
    }
    if (!selected) {
      report.found.selectedWidget = "NOT FOUND — is a widget selected on the canvas?";
      // Fall back to dumping every canvas widget's attributes, so we can at
      // least see whether an id is exposed there at all.
      report.found.anyCanvasWidgets = [...document.querySelectorAll('#cssCanvas [data-testid="widget"]')]
        .slice(0, 4)
        .map(describe);
    } else {
      report.found.selectedWidget = describe(selected);
      report.found.selectedWidgetFibers = climb(selected, "selected widget");
    }

    // 4. the trigger list sections in the context pane
    // Every section, not a sample: a custom widget declaring several events
    // renders one section per event, and each one needs its own eventName.
    const groups = [...document.querySelectorAll('[class*="triggerGroupStyles"]')];
    report.found.triggerGroupCount = groups.length;
    report.found.triggerGroups = groups.map((group) => {
      const heading = group.querySelector('[class*="triggerHeaderLabel"]');
      return {
        heading: heading ? heading.textContent.trim() : null,
        groupClass: (group.getAttribute("class") || "").slice(0, 200),
        headingHtml: heading ? heading.outerHTML.slice(0, 600) : null,
        fibers: climb(group, "group"),
      };
    });

    const json = JSON.stringify(report, null, 2)
      .split(location.hostname)
      .join("your-instance.tulip.co");
    window.__widgetProbeJson = json;
    console.log(json);
    console.log("[widgetProbe] done — run copy(__widgetProbeJson) alone at the prompt");
    return "done";
  };

  console.log("[widgetProbe] loaded. Select the target widget, then run __widgetProbe()");
})();
