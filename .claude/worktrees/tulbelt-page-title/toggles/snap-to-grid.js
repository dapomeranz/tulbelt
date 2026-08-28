// In the app editor, snap a widget's position/size to a grid when a drag or
// resize ends. Tulip owns the drag entirely; we only write the snapped value
// back afterward.
//
// Widget position/size lives in Tulip's React state (painted as a transform
// matrix), so poking the DOM transform is clobbered on re-render and never
// persists. Instead we write through the context-pane number inputs Tulip
// renders for the selected widget. Those inputs commit to the widget model on
// blur/Enter (not on every keystroke), so we set the value and then dispatch
// input/change + Enter + blur to make Tulip's commit handler persist it.
//
// Flow per interaction:
//   * pointerdown on the canvas arms the interaction.
//   * the first pointermove captures the pre-drag baseline (by then Tulip has
//     selected the widget) and, once movement passes a threshold, marks it a
//     real drag/resize. A plain click never passes the threshold, so nothing
//     snaps — selecting a widget leaves it untouched.
//   * pointerup polls the inputs (Tulip commits the moved value a few frames
//     late) and snaps the fields that actually changed: a move snaps X/Y, a
//     resize snaps W/H (and X/Y if the handle moved them).
//
// Node-shape checks use nodeType/tagName (not instanceof) and we scan reachable
// frames, since the canvas/context pane may live in a subframe (different realm
// = different constructors).

(() => {
  const FEATURE_ID = "snap-to-grid";
  const STORAGE_KEY = "toggles";
  const GRID = 10;
  const EPSILON = 0.001;
  // Pointer travel (px) before a press counts as a drag rather than a click.
  const DRAG_THRESHOLD_PX = 3;

  const INPUT_TESTIDS = {
    x: "context-pane-tool-position-x",
    y: "context-pane-tool-position-y",
    w: "context-pane-tool-size-w",
    h: "context-pane-tool-size-h",
  };

  let enabled = false;
  let armed = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  /** @type {{x:number|null,y:number|null,w:number|null,h:number|null}|null} */
  let before = null;
  /** @type {Document[]} */
  let hookedDocs = [];
  let sweepHandle = null;

  // ---------- reachable documents (cross-frame) ----------
  function documentsToScan() {
    /** @type {Document[]} */
    const out = [];
    const seen = new Set();
    const add = (d) => {
      if (!d || seen.has(d)) return;
      seen.add(d);
      out.push(d);
    };

    add(document);

    try {
      let w = window;
      for (let i = 0; i < 32 && w && w.parent && w !== w.parent; i++) {
        try {
          w = w.parent;
          add(w.document);
        } catch (_) {
          break;
        }
      }
    } catch (_) {}

    try {
      add(window.top.document);
    } catch (_) {}

    function descend(w) {
      try {
        for (let i = 0; i < w.frames.length; i++) {
          try {
            const fw = w.frames[i];
            add(fw.document);
            descend(fw);
          } catch (_) {}
        }
      } catch (_) {}
    }
    try {
      descend(window.top);
    } catch (_) {
      try {
        descend(window);
      } catch (_) {}
    }

    return out;
  }

  // ---------- scope ----------
  // App version editor pages only: /w/<ws>/apps/<id>/versions/... or
  // /apps/<id>/versions/...
  const EDITOR_PATH = /(?:\/w\/[^/]+)?\/apps\/[^/]+\/versions\//;
  function pathMatches() {
    try {
      return EDITOR_PATH.test(location.pathname);
    } catch (_) {
      return false;
    }
  }

  // ---------- input lookup / read / write ----------
  function findInput(testid) {
    for (const doc of documentsToScan()) {
      try {
        const el = doc.querySelector('input[data-testid="' + testid + '"]');
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function readNumber(testid) {
    const el = findInput(testid);
    if (!el) return null;
    const n = parseFloat(el.value);
    return Number.isFinite(n) ? n : null;
  }

  function readPlacement() {
    return {
      x: readNumber(INPUT_TESTIDS.x),
      y: readNumber(INPUT_TESTIDS.y),
      w: readNumber(INPUT_TESTIDS.w),
      h: readNumber(INPUT_TESTIDS.h),
    };
  }

  function snapValue(v) {
    return Math.round(v / GRID) * GRID;
  }

  // Write a value the way a user edit would: focus, set the value through React's
  // overridden native setter, fire input/change (drives React onChange), then
  // Enter and blur so Tulip's commit-on-blur/Enter handler persists it. The
  // input's own window prototype/constructors are used so it works across realms
  // (subframes).
  function setInputValue(input, value) {
    try {
      const view = input.ownerDocument?.defaultView || window;
      const proto = view.HTMLInputElement?.prototype || HTMLInputElement.prototype;
      const KeyEvt = view.KeyboardEvent || KeyboardEvent;
      const Evt = view.Event || Event;
      const str = String(value);

      try {
        input.focus({ preventScroll: true });
      } catch (_) {
        input.focus?.();
      }

      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(input, str);
      else input.value = str;

      input.dispatchEvent(new Evt("input", { bubbles: true }));
      input.dispatchEvent(new Evt("change", { bubbles: true }));

      const enter = {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      };
      input.dispatchEvent(new KeyEvt("keydown", enter));
      input.dispatchEvent(new KeyEvt("keyup", enter));

      try {
        input.blur();
      } catch (_) {}
      input.dispatchEvent(new Evt("focusout", { bubbles: true }));
    } catch (_) {}
  }

  function changed(a, b) {
    return a !== null && b !== null && Math.abs(a - b) > EPSILON;
  }

  function placementChanged(start, after) {
    return (
      changed(start.x, after.x) ||
      changed(start.y, after.y) ||
      changed(start.w, after.w) ||
      changed(start.h, after.h)
    );
  }

  function snapField(testid, beforeVal, afterVal) {
    if (beforeVal === null || afterVal === null) return;
    if (Math.abs(afterVal - beforeVal) <= EPSILON) return; // unchanged this drag
    const snapped = snapValue(afterVal);
    if (Math.abs(snapped - afterVal) <= EPSILON) return; // already on grid
    const el = findInput(testid);
    if (!el) return;
    setInputValue(el, snapped);
  }

  // ---------- gesture handling ----------
  function withinCanvas(target) {
    if (!target || typeof target !== "object" || target.nodeType !== 1) {
      return false;
    }
    try {
      return !!(target.closest?.("#cssCanvas") || target.closest?.('[data-testid="widget"]'));
    } catch (_) {
      return false;
    }
  }

  function onPointerDown(e) {
    if (!enabled || !pathMatches()) return;
    if (e.button !== 0) return; // primary button only
    if (!withinCanvas(e.target)) return;
    armed = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    before = null; // captured on the first move, once Tulip has selected
  }

  function onPointerMove(e) {
    if (!armed) return;
    // First move: Tulip has now selected the widget and the pane shows its
    // pre-drag values (it stays static during the drag), so this is a clean
    // baseline.
    if (before === null) before = readPlacement();
    if (!moved) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        moved = true;
      }
    }
  }

  // Tulip commits the dragged/resized values to the context-pane inputs
  // asynchronously over several frames after pointerup — and a resize can commit
  // w, h, and x/y on different frames. Poll the inputs and snap only once the
  // reading has *stabilized* (two consecutive equal samples) and differs from the
  // pre-drag baseline, so we don't snap a half-committed resize. Fall back to the
  // last sample if it changed but never went quiet; bail if nothing changed.
  const SETTLE_DELAYS_MS = [16, 50, 100, 200, 350, 550, 800, 1100];

  function onPointerUp() {
    if (!armed) return;
    armed = false;
    const start = before;
    const wasDrag = moved;
    moved = false;
    before = null;
    if (!wasDrag || !start) return; // a click (or no baseline) snaps nothing

    let done = false;
    let prev = null;
    const snapNow = (after) => {
      if (done) return;
      done = true;
      snapField(INPUT_TESTIDS.x, start.x, after.x);
      snapField(INPUT_TESTIDS.y, start.y, after.y);
      snapField(INPUT_TESTIDS.w, start.w, after.w);
      snapField(INPUT_TESTIDS.h, start.h, after.h);
    };

    SETTLE_DELAYS_MS.forEach((ms, i) => {
      setTimeout(() => {
        if (done) return;
        const after = readPlacement();
        const movedFromStart = placementChanged(start, after);
        const stable = prev !== null && !placementChanged(prev, after);
        if (movedFromStart && stable) {
          snapNow(after);
          return;
        }
        prev = after;
        if (i === SETTLE_DELAYS_MS.length - 1 && movedFromStart) {
          snapNow(after);
        }
      }, ms);
    });
  }

  function installHooksOn(doc) {
    if (!doc || hookedDocs.includes(doc)) return;
    try {
      doc.addEventListener("pointerdown", onPointerDown, true);
      doc.addEventListener("pointermove", onPointerMove, true);
      doc.addEventListener("pointerup", onPointerUp, true);
      hookedDocs.push(doc);
    } catch (_) {}
  }

  function installHooks() {
    for (const doc of documentsToScan()) installHooksOn(doc);
  }

  function removeHooks() {
    for (const doc of hookedDocs) {
      try {
        doc.removeEventListener("pointerdown", onPointerDown, true);
        doc.removeEventListener("pointermove", onPointerMove, true);
        doc.removeEventListener("pointerup", onPointerUp, true);
      } catch (_) {}
    }
    hookedDocs = [];
    armed = false;
    moved = false;
    before = null;
  }

  // ---------- toggle ----------
  async function syncFromStorage() {
    let stored = {};
    try {
      const raw = await chrome.storage.local.get(STORAGE_KEY);
      if (raw[STORAGE_KEY] && typeof raw[STORAGE_KEY] === "object") {
        stored = raw[STORAGE_KEY];
      }
    } catch (_) {}
    const next = stored[FEATURE_ID] === true;
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      installHooks();
      // Reach frames that mount after enable.
      sweepHandle = setInterval(installHooks, 1500);
    } else {
      if (sweepHandle) {
        clearInterval(sweepHandle);
        sweepHandle = null;
      }
      removeHooks();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) syncFromStorage();
  });

  syncFromStorage();
})();
