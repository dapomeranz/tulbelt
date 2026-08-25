// Flattens Tulip's top navigation: the links Tulip only reveals inside the
// header's hover dropdowns are lifted into the header bar itself, and the
// dropdowns stop opening.
//
// Which links live in those menus isn't fixed — it varies with the tenant's
// license and the signed-in user's permissions — so the list can't be
// hardcoded. It's read off the live header once per workspace and cached in
// chrome.storage, by two routes:
//
//   1. A MutationObserver on each trigger's own popper, armed before anything
//      slow runs, which reads a menu the moment Tulip fills it in — including
//      when the *user's* own cursor opens it.
//   2. A probe that asks the menus to open: hover, hover on the parent, a
//      document-level pointer move, then focus + ArrowDown. It runs one pass per
//      strategy across every unread menu rather than one pass per menu, with
//      poppers pinned `visibility: hidden` so nothing flashes open. This works
//      on some Tulip builds and on none of the others: the production header's
//      dropdowns ignore dispatched pointer events entirely, however faithfully
//      shaped (verified against the real site — a real cursor opens every menu,
//      a dispatched one opens none). A host that answers nothing is remembered
//      as such and stops being probed, so the cost isn't paid on every load.
//
// Reads are scoped to the trigger's own sibling popper, never a document-wide
// sweep: a Tulip page carries ~18 poppers and a stray open one gets recorded
// against the wrong menu. Flattening is all-or-nothing — a menu that reads as
// empty never opened, and flattening around it leaves a half-done nav.
//
// The originals are hidden with an attribute + stylesheet rather than removed
// (React still owns them), and each flattened link is a *clone* of a plain nav
// anchor, so it inherits the styled-component classes without inheriting the
// hover handler that opens a dropdown. A clone carries no React router
// binding either, so a plain left click is routed through the real menu the
// same way `move-variables-to-toolbar` drives the real Variables button:
// re-open the (still display:none) source menu off-screen, click the matching
// real anchor, and fall back to normal navigation if that doesn't pan out.

(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "flatten-top-menu";
  const STYLE_ID = "tulbelt-flatten-top-menu-styles";
  const PROBE_STYLE_ID = "tulbelt-flatten-top-menu-probe-styles";
  const CACHE_KEY = "flatNavMenus";
  const PROBE_KEY = "flatNavProbe";
  // Bump to re-probe every instance — do it whenever a new open strategy is
  // added, or hosts that answered none of the old ones would never be retried.
  const PROBE_VERSION = 1;
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  // Bump whenever a change here would make previously harvested entries wrong.
  const CACHE_VERSION = 3;

  const HEADER_SELECTOR = '[data-testid="tulip-header"]';
  const MENU_ANCHOR_SELECTOR = 'a[aria-haspopup="menu"]';
  const POPPER_SELECTOR = '[data-testid="popper"], [role="menu"]';

  const HIDDEN_ATTR = "data-tulbelt-flat-nav-hidden";
  const RENDERED_ATTR = "data-tulbelt-flat-nav-rendered";
  const CLONE_ATTR = "data-tulbelt-flat-nav-item";
  const GROUP_ATTR = "data-tulbelt-flat-nav-group";
  const PARENT_ATTR = "data-tulbelt-flat-nav-parent";

  const POLL_MS = 50;
  // Per open strategy, not per menu. Kept short because there are several of
  // them and the watcher is already armed — the probe is a bonus, not the plan.
  const MENU_OPEN_TIMEOUT_MS = 700;
  const MENU_CLOSE_TIMEOUT_MS = 800;
  const MENU_SETTLE_MS = 250;
  const CLICK_PROBE_TIMEOUT_MS = 700;
  // Only used when a trigger has no popper to watch, so the probe is the only
  // way in and is worth retrying against a header React hasn't finished wiring.
  const MAX_PROBE_ATTEMPTS = 3;
  const PROBE_RETRY_MS = 3000;
  // Page loads on a fresh instance that will try probing before giving up on it.
  const MAX_PROBE_VISITS = 3;

  const HIDE_CSS = `[${HIDDEN_ATTR}="true"] { display: none !important; }`;
  const PROBE_CSS = `${POPPER_SELECTOR} { visibility: hidden !important; pointer-events: none !important; }`;

  let enabled = false;
  let cache = null; // { key, groups }
  let harvesting = false;
  let probed = false;
  let probeAttempts = 0;
  let lastCacheKey = "";
  // Set once a lookup comes back empty so apply() stops hitting storage on
  // every mutation batch; a timer lifts it for the next attempt.
  let blocked = false;
  // Flipped to false the first time the click-through probe times out, so a
  // Tulip build we can't drive costs one slow click, not one per click.
  let routeThroughMenus = true;
  // The trigger this took focus from <body> for, so the keyboard route can tell
  // its own focus from focus the user placed somewhere.
  let focusTaken = null;
  let activeTemplate = null;
  let inactiveTemplate = null;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Routed through the dev-tools buffer (inert unless that toggle and developer
  // mode are both on), so a header this can't read is diagnosable from a
  // `__tulbelt.copy()` report instead of guesswork. See docs/devtools.md.
  const trace = (...args) => window.__tulbelt?.log?.(FEATURE_ID, ...args);

  // Status flags Tulip pins to a nav row — "Vision New", "Machines Upgrade".
  // Extend this list rather than reaching for a cleverer heuristic: a flag is
  // just a word, and guessing structurally risks eating a real link name.
  const FLAG_WORDS = new Set([
    "new",
    "beta",
    "alpha",
    "preview",
    "early access",
    "upgrade",
    "trial",
    "add-on",
    "addon",
    "coming soon",
    "deprecated",
  ]);
  const TRAILING_FLAG = new RegExp(`\\s+(?:${[...FLAG_WORDS].join("|")})$`, "i");

  // What the element reads as, flags and all. Every decision about *whether* a
  // link gets flattened runs on this and only this — dedupe, parent/child
  // matching, and the "did this menu read?" test. Keeping it dumb is the point:
  // the one time label extraction got clever enough to return an empty string,
  // rows started looking unreadable and whole headers stopped flattening.
  const labelOf = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();

  // The text a flattened link displays. Purely cosmetic, computed at harvest
  // time alongside labelOf and consulted nowhere else, so however wrong it goes
  // the worst case is a slightly-off caption — never a missing link.
  //
  // A flag is a sibling element of the name, so textContent glues the two
  // together — <div>Vision</div><span>New</span> reads as "VisionNew" — and the
  // caption is rebuilt from the individual text nodes instead, dropping parts
  // that are a flag on their own. The trailing sweep catches a flag sharing its
  // text node with the name ("Vision New"). Each step falls back to the wider
  // reading, so this never comes out emptier than textContent.
  function captionOf(el) {
    const parts = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.data.replace(/\s+/g, " ").trim();
          if (text) parts.push(text);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child);
        }
      }
    };
    walk(el);
    const named = parts.filter((part) => !FLAG_WORDS.has(part.toLowerCase()));
    const caption = (named.length ? named : parts).join(" ").replace(/\s+/g, " ").trim();
    return caption.replace(TRAILING_FLAG, "").trim() || caption || labelOf(el);
  }

  function pathOf(href) {
    if (!href) return "";
    try {
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return url.href;
      return url.pathname.replace(/\/+$/, "") || "/";
    } catch {
      return href;
    }
  }

  // Top-level section of a nav path, ignoring the workspace prefix:
  // "/w/DEFAULT/apps/folders" and "/w/DEFAULT/apps/x/versions/y" are both "apps".
  function sectionOf(path) {
    const withoutWorkspace = path.replace(/^\/w\/[^/]+/, "");
    return (withoutWorkspace.split("/").filter(Boolean)[0] || "").toLowerCase();
  }

  const groupKeyOf = (anchor) =>
    anchor.id || labelOf(anchor) || pathOf(anchor.getAttribute("href"));

  function cacheKeyFor(anchors) {
    let workspace = location.pathname.match(/^\/w\/([^/]+)/)?.[1] ?? "";
    for (const anchor of anchors) {
      const match = pathOf(anchor.getAttribute("href")).match(/^\/w\/([^/]+)/);
      if (match) {
        workspace = match[1];
        break;
      }
    }
    return `${location.host}|${workspace}`;
  }

  async function readCache(key) {
    const { [CACHE_KEY]: all = {} } = await chrome.storage.local.get(CACHE_KEY);
    return all[key] ?? null;
  }

  async function writeCache(key, entry) {
    const { [CACHE_KEY]: all = {} } = await chrome.storage.local.get(CACHE_KEY);
    await chrome.storage.local.set({ [CACHE_KEY]: { ...all, [key]: entry } });
  }

  // Whether asking this instance to open its own menus has ever worked. On a
  // host that answers nothing, probing is several seconds of pointless work on
  // every single page load — and the keyboard route puts a visible focus ring on
  // each link as it goes. Learn the answer once and stop.
  // A few failures rather than one, because the first page load on an instance
  // is the worst moment to judge: React may still be wiring the header up. One
  // unlucky visit must not switch probing off for a host forever.
  async function probeAllowed(host) {
    const { [PROBE_KEY]: all = {} } = await chrome.storage.local.get(PROBE_KEY);
    const known = all[host];
    if (!known || known.v !== PROBE_VERSION) return true;
    return known.worked === true || (known.fails ?? 0) < MAX_PROBE_VISITS;
  }

  async function recordProbe(host, worked) {
    const { [PROBE_KEY]: all = {} } = await chrome.storage.local.get(PROBE_KEY);
    const known = all[host]?.v === PROBE_VERSION ? all[host] : null;
    if (known?.worked === worked && worked) return;
    const entry = worked
      ? { worked: true, fails: 0, v: PROBE_VERSION }
      : { worked: false, fails: (known?.fails ?? 0) + 1, v: PROBE_VERSION };
    await chrome.storage.local.set({ [PROBE_KEY]: { ...all, [host]: entry } });
  }

  /* ---------------------------------------------------------------- hovering */

  function pointAt(el) {
    const rect = el.getBoundingClientRect();
    return {
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
    };
  }

  function fireMouse(el, type, extra = {}) {
    const bubbles = type !== "mouseenter" && type !== "mouseleave";
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles,
        cancelable: true,
        view: window,
        ...pointAt(el),
        ...extra,
      }),
    );
  }

  function firePointer(el, type, extra = {}) {
    if (typeof PointerEvent !== "function") return;
    const bubbles = type !== "pointerenter" && type !== "pointerleave";
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles,
        cancelable: true,
        view: window,
        pointerType: "mouse",
        isPrimary: true,
        ...pointAt(el),
        ...extra,
      }),
    );
  }

  // React synthesises onMouseEnter/onMouseLeave from mouseover/mouseout pairs,
  // and some Tulip surfaces listen for the pointer events directly — fire both
  // families so either implementation opens.
  function hoverIn(el) {
    firePointer(el, "pointerover", { relatedTarget: document.body });
    firePointer(el, "pointerenter");
    fireMouse(el, "mouseover", { relatedTarget: document.body });
    fireMouse(el, "mouseenter");
    fireMouse(el, "mousemove");
  }

  function hoverOut(el) {
    firePointer(el, "pointerout", { relatedTarget: document.body });
    firePointer(el, "pointerleave", { relatedTarget: document.body });
    fireMouse(el, "mouseout", { relatedTarget: document.body });
    fireMouse(el, "mouseleave", { relatedTarget: document.body });
    // The pointer "arriving" somewhere else is what React turns into the leave.
    document.body.dispatchEvent(
      new MouseEvent("mouseover", {
        bubbles: true,
        cancelable: true,
        view: window,
        relatedTarget: el,
      }),
    );
  }

  // The dropdown Tulip renders for a trigger is its own following sibling, and
  // scoping reads to it matters: a Tulip page carries ~18 poppers, so a document
  // -wide sweep can pick up an unrelated one that happens to be open and record
  // its links against the wrong menu.
  function popperFor(anchor) {
    for (let el = anchor.nextElementSibling; el; el = el.nextElementSibling) {
      if (el.matches?.(POPPER_SELECTOR)) return el;
      if (el.matches?.(MENU_ANCHOR_SELECTOR)) break; // reached the next trigger
    }
    return null;
  }

  // Menu rows inside a popper that currently has layout boxes. A closed popper is
  // `display: none` and so has none, which holds even while the probe stylesheet
  // pins the open one to `visibility: hidden`.
  function popperRows(popper) {
    if (!popper?.getClientRects().length) return [];
    return [...popper.querySelectorAll("a[href]")]
      .filter((row) => !row.hasAttribute(CLONE_ATTR))
      .map(describe)
      .filter((row) => row.href && row.label);
  }

  // Fallback for a build that portals its open menu somewhere else entirely.
  function openMenuAnchors() {
    const anchors = [];
    for (const popper of document.querySelectorAll(POPPER_SELECTOR)) {
      if (!popper.getClientRects().length) continue;
      for (const anchor of popper.querySelectorAll("a[href]")) {
        if (anchor.hasAttribute(CLONE_ATTR)) continue;
        anchors.push(anchor);
      }
    }
    return anchors;
  }

  function describe(anchor) {
    const label = labelOf(anchor);
    const caption = captionOf(anchor);
    return {
      href: anchor.getAttribute("href") || "",
      label,
      // Only carried when stripping actually changed something, so the common
      // row stays a plain {href, label} pair in the cache and in signatures.
      caption: caption === label ? "" : caption,
      target: anchor.getAttribute("target") || "",
    };
  }

  const rowsFor = (anchor) => {
    const own = popperRows(popperFor(anchor));
    if (own.length) return own;
    // No sibling popper: this build portals the open menu elsewhere.
    return popperFor(anchor)
      ? []
      : openMenuAnchors()
          .map(describe)
          .filter((row) => row.href && row.label);
  };

  // Moves the pointer over the anchor at document level, for a floating-element
  // library that tracks the cursor globally rather than listening on its target.
  function movePointerOver(anchor) {
    const point = pointAt(anchor);
    for (const target of [document, anchor.parentElement, anchor]) {
      if (!target) continue;
      firePointer(anchor, "pointermove", point);
      target.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, cancelable: true, view: window, ...point }),
      );
    }
    return true;
  }

  // aria-haspopup="menu" implies the menu is reachable from the keyboard, which
  // is a route that has nothing to do with pointer trust. Never takes focus off
  // something the user is actually using.
  function openWithKeyboard(anchor) {
    const focused = document.activeElement;
    // `focusTaken` matters: having focused the first trigger, focus is no longer
    // on <body>, and without this every menu after the first was skipped.
    const idle =
      !focused ||
      focused === document.body ||
      focused === document.documentElement ||
      focused === focusTaken;
    if (!idle) return false;
    focusTaken = anchor;
    anchor.focus({ preventScroll: true });
    for (const type of ["keydown", "keyup"]) {
      anchor.dispatchEvent(
        new KeyboardEvent(type, {
          key: "ArrowDown",
          code: "ArrowDown",
          keyCode: 40,
          which: 40,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    return true;
  }

  // Ways to ask a dropdown to open, least intrusive first. None of them navigate
  // or take focus from the user. The production header answers none — that's
  // what the watcher is for — but other builds answer the first, and asking is
  // cheap now that the watcher is armed before any of this runs.
  const OPEN_STRATEGIES = [
    { name: "hover", open: (a) => (hoverIn(a), true), close: hoverOut },
    {
      name: "hover-parent",
      open: (a) => (a.parentElement ? (hoverIn(a.parentElement), hoverIn(a), true) : false),
      close: (a) => {
        hoverOut(a);
        if (a.parentElement) hoverOut(a.parentElement);
      },
    },
    { name: "pointer-move", open: movePointerOver, close: hoverOut },
    {
      name: "keyboard",
      serial: true,
      // Either the menu is keyboard-openable or it isn't; there's no hover-intent
      // delay to wait out, so this needs far less patience than the pointer routes.
      budgetMs: 400,
      open: openWithKeyboard,
      close: (a) => {
        if (focusTaken === a) {
          a.blur();
          focusTaken = null;
        }
        hoverOut(a);
      },
    },
  ];

  // Watches several menus at once, recording each as it settles — two identical
  // non-empty reads in a row, so a half-rendered menu is never recorded. Menus
  // are read from their own poppers, so probing them concurrently costs nothing
  // and turns the probe from per-menu into per-strategy.
  async function settleAll(anchors, budgetMs, via) {
    const previous = new Map();
    const done = new Set();
    for (let waited = 0; waited < budgetMs; waited += POLL_MS) {
      await delay(POLL_MS);
      for (const anchor of anchors) {
        if (done.has(anchor)) continue;
        const items = rowsFor(anchor);
        const signature = JSON.stringify(items);
        if (items.length && signature === previous.get(anchor)) {
          done.add(anchor);
          remember(anchor, items);
          trace("menu opened", { key: groupKeyOf(anchor), via });
          continue;
        }
        previous.set(anchor, signature);
      }
      if (done.size === anchors.length) return;
    }
  }

  // One pass per strategy across every unread menu, rather than one pass per
  // menu — the whole header is probed in the time a single menu used to take.
  // Strategies stack rather than take turns: closing between them would cancel a
  // hover-intent timer that hadn't fired yet, so a header with a lazy delay
  // would never open however long the probe ran. Everything is undone at the end.
  async function sweepTogether(anchors) {
    const opened = new Map(anchors.map((anchor) => [anchor, []]));
    try {
      for (const strategy of OPEN_STRATEGIES) {
        const waiting = anchors.filter((anchor) => !captured.has(groupKeyOf(anchor)));
        if (!waiting.length) return;
        const budget = strategy.budgetMs ?? MENU_OPEN_TIMEOUT_MS;
        if (strategy.serial) {
          // Focus can only be in one place, so this one can't be batched.
          for (const anchor of waiting) {
            if (!strategy.open(anchor)) continue;
            opened.get(anchor).push(strategy);
            await settleAll([anchor], budget, strategy.name);
          }
          continue;
        }
        const started = waiting.filter((anchor) => strategy.open(anchor));
        for (const anchor of started) opened.get(anchor).push(strategy);
        if (started.length) await settleAll(started, budget, strategy.name);
      }
    } finally {
      for (const [anchor, used] of opened) {
        for (const strategy of used.reverse()) strategy.close(anchor);
      }
      for (const anchor of anchors) await closeMenu(anchor);
    }
  }

  // A trigger with no popper of its own can only be read by looking across the
  // document, which is only sound while exactly one menu is open. So these get
  // probed strictly alone — strategies still stack, but the next trigger doesn't
  // start until this one is shut.
  async function sweepAlone(anchor) {
    const opened = [];
    try {
      for (const strategy of OPEN_STRATEGIES) {
        if (captured.has(groupKeyOf(anchor))) return;
        if (!strategy.open(anchor)) continue;
        opened.push(strategy);
        await settleAll([anchor], strategy.budgetMs ?? MENU_OPEN_TIMEOUT_MS, strategy.name);
      }
    } finally {
      for (const strategy of opened.reverse()) strategy.close(anchor);
      await closeMenu(anchor);
    }
  }

  async function sweep(anchors) {
    const scoped = anchors.filter((anchor) => popperFor(anchor));
    if (scoped.length) await sweepTogether(scoped);
    for (const anchor of anchors) {
      if (!popperFor(anchor)) await sweepAlone(anchor);
    }
  }

  async function closeMenu(anchor) {
    hoverOut(anchor);
    for (let waited = 0; waited < MENU_CLOSE_TIMEOUT_MS; waited += POLL_MS) {
      if (!rowsFor(anchor).length) return;
      await delay(POLL_MS);
    }
  }

  // Synthetic hover works on some Tulip builds and on none of the others: the
  // production header's dropdowns don't respond to dispatched pointer/mouse
  // events at all, no matter how faithfully shaped. So it's tried exactly once
  // per page, cheaply, and whatever it can't get is left to the watcher below.
  async function probe(anchors) {
    ensureStyles(PROBE_STYLE_ID, PROBE_CSS);
    try {
      await sweep(anchors);
    } finally {
      removeStyles(PROBE_STYLE_ID);
    }
  }

  /* ------------------------------------------------------------ menu sources */

  // Menus recorded so far this page, by group key. Filled by the probe when that
  // works and by the watcher when it doesn't; a header is only flattened once
  // every trigger has an entry.
  const captured = new Map();
  const watchers = [];
  let settleTimer = null;

  function remember(anchor, children) {
    const key = groupKeyOf(anchor);
    // Menus render progressively, so a later read that saw more rows wins. Never
    // downgrade — that's how a menu ends up flattened to a single stray link.
    if ((captured.get(key)?.children.length ?? 0) >= children.length) return false;
    captured.set(key, { ...describe(anchor), key, children });
    trace("recorded menu", { key, count: children.length });
    return true;
  }

  const assemble = (anchors) =>
    anchors.every((anchor) => captured.has(groupKeyOf(anchor)))
      ? anchors.map((anchor) => captured.get(groupKeyOf(anchor)))
      : null;

  function stopWatching() {
    clearTimeout(settleTimer);
    settleTimer = null;
    for (const observer of watchers) observer.disconnect();
    watchers.length = 0;
  }

  // When dispatched events can't open the menus, the user's own cursor still
  // can. Watch each trigger's popper and read it the moment Tulip fills it in —
  // no synthetic events, no interference, and it costs the user one hover per
  // menu, once, before the answer is cached.
  function watchForRealHovers(anchors, key) {
    stopWatching();
    for (const anchor of anchors) {
      const popper = popperFor(anchor);
      if (!popper) continue;
      const observer = new MutationObserver(() => {
        // Menus arrive in pieces; settle before reading so the first frame of a
        // half-built list isn't what gets recorded.
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          const rows = popperRows(popper);
          if (!rows.length || !remember(anchor, rows)) return;
          const groups = assemble(anchors);
          if (groups) void adopt(key, groups);
        }, MENU_SETTLE_MS);
      });
      observer.observe(popper, {
        attributes: true,
        attributeFilter: ["style", "class"],
        childList: true,
        subtree: true,
      });
      watchers.push(observer);
    }
    trace("watching for real hovers", { menus: watchers.length });
  }

  async function adopt(key, groups) {
    stopWatching();
    cache = { key, groups };
    blocked = false;
    await writeCache(key, { v: CACHE_VERSION, at: Date.now(), groups });
    apply();
  }

  const covers = (groups, anchors) =>
    anchors.every((anchor) => groups.some((group) => group.key === groupKeyOf(anchor)));

  function cachedGroupsFor(anchors) {
    if (!cache || cache.key !== cacheKeyFor(anchors)) return null;
    return covers(cache.groups, anchors) ? cache.groups : null;
  }

  async function loadGroups(anchors) {
    if (harvesting) return null;
    harvesting = true;
    const key = cacheKeyFor(anchors);
    try {
      const stored = await readCache(key);
      if (
        stored?.v === CACHE_VERSION &&
        Date.now() - stored.at < CACHE_TTL_MS &&
        covers(stored.groups, anchors)
      ) {
        cache = { key, groups: stored.groups };
        return cache.groups;
      }
      // Armed before anything slow runs. The probe below can take seconds, and
      // a hover during that window is exactly the hover a user makes on a fresh
      // page — missing it is what made this feel like it needed several tries.
      watchForRealHovers(anchors, key);
      if (!probed) {
        probed = true;
        // Clicking a clone routes through its real menu the same way probing
        // does, so a host that can't be probed can't be routed either — decided
        // up front rather than charging the user a timeout on their first click.
        const allowed = await probeAllowed(location.host);
        if (!allowed) routeThroughMenus = false;
        if (allowed) {
          await probe(anchors);
          const worked = captured.size > 0;
          if (!worked) routeThroughMenus = false;
          await recordProbe(location.host, worked);
          trace("probe finished", { key, worked, recorded: captured.size, of: anchors.length });
        }
      }
      // All or nothing: a menu that read as empty means it never opened, not
      // that it's empty, and flattening the rest around it leaves a half-done
      // nav that reads as a bug.
      const groups = assemble(anchors);
      if (!groups) return null; // the watcher stays armed and finishes the job
      stopWatching();
      cache = { key, groups };
      await writeCache(key, { v: CACHE_VERSION, at: Date.now(), groups });
      return groups;
    } finally {
      harvesting = false;
    }
  }

  /* -------------------------------------------------------------- rendering */

  function isHighlighted(anchor) {
    const colour = anchor.style.borderBottomColor;
    if (!colour) return false;
    const channels = colour.match(/^rgba?\(([^)]+)\)$/);
    if (!channels) return true;
    const parts = channels[1].split(",").map((part) => parseFloat(part));
    return parts.length < 4 || parts[3] > 0;
  }

  const templateOf = (anchor) => ({
    className: anchor.className,
    style: anchor.getAttribute("style") || "",
  });

  // The active/inactive looks are read off Tulip's own anchors — the hashed
  // styled-component class names change between builds and must never be
  // hardcoded. Hidden originals still get their highlight updated by React, so
  // they stay usable as templates after flattening.
  function captureTemplates(header) {
    for (const anchor of header.querySelectorAll("a[href]")) {
      if (anchor.hasAttribute(CLONE_ATTR)) continue;
      if (isHighlighted(anchor)) activeTemplate = templateOf(anchor);
      else if (!anchor.hasAttribute("aria-haspopup")) inactiveTemplate = templateOf(anchor);
    }
    if (!inactiveTemplate) {
      const fallback = header.querySelector(MENU_ANCHOR_SELECTOR);
      if (fallback && !isHighlighted(fallback)) inactiveTemplate = templateOf(fallback);
    }
  }

  function buildAnchor(item, groupKey) {
    const anchor = document.createElement("a");
    anchor.setAttribute(CLONE_ATTR, "true");
    anchor.setAttribute(GROUP_ATTR, groupKey);
    if (item.parent) anchor.setAttribute(PARENT_ATTR, "true");
    anchor.setAttribute("href", item.href);
    if (item.target) {
      anchor.setAttribute("target", item.target);
      anchor.setAttribute("rel", "noopener noreferrer");
    }
    anchor.className = inactiveTemplate?.className ?? "";
    if (inactiveTemplate?.style) anchor.setAttribute("style", inactiveTemplate.style);
    // The stripped caption is only ever the text on screen — item.label is what
    // the rest of the pipeline matched on.
    anchor.textContent = item.caption || item.label;
    anchor.addEventListener("click", onCloneClick);
    return anchor;
  }

  // What a single dropdown flattens into. The parent link is kept only when its
  // own destination isn't already one of the children — "Shop floor" points at
  // the same page as its "Stations" child and so disappears, while "Apps"
  // survives if its menu has no Apps entry of its own.
  function planFor(group, taken) {
    const items = [];
    const parentPath = pathOf(group.href);
    const parentLabel = group.label.toLowerCase();
    const children = group.children ?? [];
    const parentCovered = children.some(
      (child) => pathOf(child.href) === parentPath || child.label.toLowerCase() === parentLabel,
    );
    if (!parentCovered && group.href) {
      items.push({
        href: group.href,
        label: group.label,
        caption: group.caption,
        target: "",
        parent: true,
      });
    }
    for (const child of children) items.push({ ...child, parent: false });

    return items.filter((item) => {
      const path = `p:${pathOf(item.href)}`;
      const label = `l:${item.label.toLowerCase()}`;
      if (taken.has(path) || taken.has(label)) return false;
      taken.add(path);
      taken.add(label);
      return true;
    });
  }

  const clonesSelector = (groupKey) => `[${CLONE_ATTR}][${GROUP_ATTR}="${CSS.escape(groupKey)}"]`;

  function removeClonesFor(groupKey) {
    for (const clone of document.querySelectorAll(clonesSelector(groupKey))) clone.remove();
  }

  function renderGroup(anchor, group, taken) {
    const plan = planFor(group, taken);
    const signature = JSON.stringify(plan.map((item) => [item.href, item.label, item.caption]));
    // A React re-render can drop our clones while leaving the original (and its
    // signature attribute) in place, so the count is checked too — otherwise the
    // links would silently never come back.
    const rendered = document.querySelectorAll(clonesSelector(group.key)).length;
    if (anchor.getAttribute(RENDERED_ATTR) !== signature || rendered !== plan.length) {
      removeClonesFor(group.key);
      let previous = anchor;
      for (const item of plan) {
        const clone = buildAnchor(item, group.key);
        previous.insertAdjacentElement("afterend", clone);
        previous = clone;
      }
      anchor.setAttribute(RENDERED_ATTR, signature);
    }
    if (anchor.getAttribute(HIDDEN_ATTR) !== "true") anchor.setAttribute(HIDDEN_ATTR, "true");
  }

  // Tulip highlights whichever nav item owns the current section; once the item
  // that used to carry it is hidden, the highlight has to be re-homed onto the
  // flattened link with the longest matching path.
  function refreshHighlight(header) {
    const clones = [...header.querySelectorAll(`[${CLONE_ATTR}]`)];
    if (!clones.length) return;
    const here = location.pathname.replace(/\/+$/, "");
    const hereSection = sectionOf(here);
    let best = null;
    let bestScore = -1;
    for (const clone of clones) {
      const path = pathOf(clone.getAttribute("href"));
      if (!hereSection || sectionOf(path) !== hereSection) continue;
      const score = here.startsWith(path) ? path.length : 0;
      if (score > bestScore) {
        bestScore = score;
        best = clone;
      }
    }
    for (const clone of clones) {
      const template = clone === best ? activeTemplate : inactiveTemplate;
      if (!template) continue;
      if (clone.className !== template.className) clone.className = template.className;
      if ((clone.getAttribute("style") || "") !== template.style) {
        anchorStyle(clone, template.style);
      }
    }
  }

  function anchorStyle(anchor, style) {
    if (style) anchor.setAttribute("style", style);
    else anchor.removeAttribute("style");
  }

  /* ---------------------------------------------------------------- clicking */

  const originalFor = (groupKey) =>
    [...document.querySelectorAll(`${HEADER_SELECTOR} ${MENU_ANCHOR_SELECTOR}`)].find(
      (anchor) => groupKeyOf(anchor) === groupKey,
    ) ?? null;

  async function findRealMenuAnchor(href) {
    const wanted = pathOf(href);
    for (let waited = 0; waited < CLICK_PROBE_TIMEOUT_MS; waited += POLL_MS) {
      await delay(POLL_MS);
      for (const anchor of openMenuAnchors()) {
        const candidate = anchor.getAttribute("href");
        if (candidate === href || pathOf(candidate) === wanted) return anchor;
      }
    }
    return null;
  }

  // Clones have no React Router binding, so a plain left click would force a
  // full page load. Drive Tulip's own link instead: re-open the source menu
  // (the original anchor is display:none, but synthetic events don't care) and
  // click the matching anchor inside it.
  async function routeThrough(clone) {
    const href = clone.getAttribute("href");
    const original = originalFor(clone.getAttribute(GROUP_ATTR));
    if (!original) {
      location.assign(href);
      return;
    }
    if (clone.hasAttribute(PARENT_ATTR)) {
      original.click();
      return;
    }
    ensureStyles(PROBE_STYLE_ID, PROBE_CSS);
    hoverIn(original);
    const target = await findRealMenuAnchor(href);
    if (target) target.click();
    else routeThroughMenus = false;
    hoverOut(original);
    // Leave the probe stylesheet up long enough for the menu to unmount, so the
    // click never leaves a stray dropdown on screen.
    setTimeout(() => removeStyles(PROBE_STYLE_ID), 300);
    if (!target) location.assign(href);
  }

  function onCloneClick(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!routeThroughMenus) return;
    event.preventDefault();
    void routeThrough(event.currentTarget);
  }

  /* ----------------------------------------------------------------- driving */

  function apply() {
    if (!enabled) return;
    const header = document.querySelector(HEADER_SELECTOR);
    if (!header) return;
    const anchors = [...header.querySelectorAll(MENU_ANCHOR_SELECTOR)];
    if (!anchors.length) {
      trace("header has no dropdown anchors", { headerHtmlLength: header.innerHTML.length });
      return;
    }

    const key = cacheKeyFor(anchors);
    if (key !== lastCacheKey) {
      lastCacheKey = key;
      probed = false;
      probeAttempts = 0;
      blocked = false;
      captured.clear();
      stopWatching();
    }

    captureTemplates(header);
    const groups = cachedGroupsFor(anchors);
    if (!groups) {
      if (blocked) return;
      void loadGroups(anchors).then((loaded) => {
        if (loaded) return apply();
        blocked = true;
        // A watcher on every trigger is the whole retry mechanism — the next
        // real hover wakes this back up. Only re-probe when there was nothing
        // to watch, and even then only a few times.
        if (!watchers.length && probeAttempts < MAX_PROBE_ATTEMPTS) {
          probeAttempts += 1;
          setTimeout(() => {
            probed = false;
            blocked = false;
            apply();
          }, PROBE_RETRY_MS);
        }
      });
      return;
    }

    // Links already in the bar win over anything a dropdown repeats.
    const taken = new Set();
    for (const anchor of header.querySelectorAll("a[href]")) {
      if (anchor.hasAttribute(CLONE_ATTR) || anchor.hasAttribute("aria-haspopup")) continue;
      taken.add(`p:${pathOf(anchor.getAttribute("href"))}`);
      taken.add(`l:${labelOf(anchor).toLowerCase()}`);
    }
    for (const anchor of anchors) {
      const group = groups.find((candidate) => candidate.key === groupKeyOf(anchor));
      if (group) renderGroup(anchor, group, taken);
    }
    refreshHighlight(header);
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
  });

  function revert() {
    for (const clone of document.querySelectorAll(`[${CLONE_ATTR}]`)) clone.remove();
    for (const anchor of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) {
      anchor.removeAttribute(HIDDEN_ATTR);
      anchor.removeAttribute(RENDERED_ATTR);
    }
    removeStyles(STYLE_ID);
    removeStyles(PROBE_STYLE_ID);
  }

  registerToggle(FEATURE_ID, {
    onEnable() {
      enabled = true;
      probed = false;
      probeAttempts = 0;
      lastCacheKey = "";
      blocked = false;
      captured.clear();
      ensureStyles(STYLE_ID, HIDE_CSS);
      apply();
      observer.observe(document.body, { childList: true, subtree: true });
      window.addEventListener("popstate", apply);
    },
    onDisable() {
      enabled = false;
      observer.disconnect();
      stopWatching();
      window.removeEventListener("popstate", apply);
      revert();
    },
  });
})();
