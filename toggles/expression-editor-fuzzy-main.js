// Main-world half of the fuzzy-search feature.
//
// Lives in `world: "MAIN"` so React fiber expando properties (`__reactFiber$…`,
// `__reactProps$…`) on DOM nodes are visible. From an isolated content-script
// world Chrome's expando bridge often returns nothing, which is why the
// previous incarnation kept failing with "no fiber on list element".
//
// Enable/disable is signalled by the isolated half via the `data-tulbelt-
// fuzzy-enabled` attribute on `<html>` (no chrome.* APIs in main world).

(() => {
const ATTR = 'data-tulbelt-fuzzy-enabled';
const STYLE_ID = 'tulbelt-fuzzy-styles';
const HIDE_REACT_LIST_ATTR = 'data-tulbelt-fuzzy-hide-react-list';
const LIST_HOST_ATTR = 'data-tulbelt-fuzzy-list-host';
const OVERLAY_CLASS = 'tulbelt-fuzzy-overlay';
const ROW_CLASS = 'tulbelt-fuzzy-row';
const FN_ROW_CLASS = 'tulbelt-fuzzy-row--fn';
const SELECTED_CLASS = 'tulbelt-fuzzy-row--selected';
const EMPTY_CLASS = 'tulbelt-fuzzy-empty';
const MAX_RESULTS = 200;

// Hard-filter: any item whose label starts with one of these prefixes
// (case-insensitive) is hidden from the overlay entirely. These are
// Tulip categories the user has flagged as "never useful" — surfacing
// them only crowds out the real results. Case-insensitive comparison
// keeps it forgiving against Tulip's label casing changing over time.
const HIDDEN_LABEL_PREFIXES = [
  '@Users',
  '@User Groups',
  '@Machine Activity Field',
  '@Last Machine Output',
  '@Current step input validity',
].map((s) => s.toLowerCase());

// Unified logging: off < select < observe < all
const LOG = { off: 0, select: 1, observe: 2, all: 3 };
const LOG_NAME = ['off', 'select', 'observe', 'all'];
let logLevel = LOG.off;

// Session log — one object for copy/paste (__tulbeltFuzzy.exportLog()).
const sessionLog = [];
let sessionStartedAt = Date.now();
let sessionRecording = false;
/** @type {'baseline'|'enhanced'|null} active __tulbeltFuzzy.capture() phase */
let capturePhase = null;
const SESSION_LOG_MAX = 500;
const SANITIZE_MAX_DEPTH = 12;
const SANITIZE_MAX_KEYS = 40;
const SANITIZE_MAX_ARRAY = 50;
const SANITIZE_MAX_STRING = 2000;

function logLevelName() {
  return LOG_NAME[logLevel] ?? 'off';
}

function objectTag(value) {
  try {
    return Object.prototype.toString.call(value);
  } catch (_) {
    return '';
  }
}

function domDescriptor(el) {
  try {
    const cls =
      typeof el.className === 'string'
        ? el.className
        : el.className?.baseVal;
    return {
      __node: objectTag(el) || 'Element',
      tag: el.tagName || el.nodeName,
      id: el.id || undefined,
      class: cls ? String(cls).slice(0, 120) : undefined,
    };
  } catch (_) {
    return { __node: 'Element' };
  }
}

/** Reliable across realms — `instanceof Element` often fails on page nodes. */
function isDomLike(value) {
  if (!value || typeof value !== 'object') return false;
  const tag = objectTag(value);
  if (tag === '[object Window]' || tag === '[object Document]' || tag === '[object DocumentFragment]') {
    return true;
  }
  if (/^\[object (HTML|SVG)/.test(tag)) return true;
  try {
    if (typeof Element !== 'undefined' && value instanceof Element) return true;
    if (typeof Node !== 'undefined' && value instanceof Node) return true;
  } catch (_) {}
  try {
    const nt = value.nodeType;
    if (typeof nt === 'number' && nt >= 1 && nt <= 12 && value.nodeName) return true;
  } catch (_) {}
  return false;
}

/** Minified React fiber (`Ic`) — never walk memoizedProps/stateNode. */
function isReactFiberLike(value) {
  if (!value || typeof value !== 'object' || isDomLike(value)) return false;
  try {
    if (typeof value.tag === 'number' && ('child' in value || 'stateNode' in value)) {
      return true;
    }
    const cn = value.constructor?.name;
    if (cn === 'FiberNode' || cn === 'Ic') return true;
  } catch (_) {}
  return false;
}

/** Plain JSON-safe clone — DOM/React fibers become short descriptors. */
function sanitizeForExport(value, seen, depth) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string') {
    return value.length > SANITIZE_MAX_STRING
      ? value.slice(0, SANITIZE_MAX_STRING) + '…'
      : value;
  }
  if (t === 'number' || t === 'boolean' || t === 'bigint') return value;
  if (t === 'symbol') return String(value);
  if (t === 'function') {
    const n = value.name;
    return n ? `[Function:${n}]` : '[Function]';
  }
  const d = depth ?? 0;
  if (d >= SANITIZE_MAX_DEPTH) return '[MaxDepth]';

  if (isDomLike(value)) return domDescriptor(value);
  if (isReactFiberLike(value)) return { __reactFiber: true };
  if (value instanceof Error) {
    return { __error: value.message, name: value.name };
  }

  if (t !== 'object') return String(value);

  const tag = objectTag(value);
  if (tag !== '[object Object]' && tag !== '[object Array]') {
    return { __host: tag };
  }

  const weak = seen ?? new WeakSet();
  if (weak.has(value)) return '[Circular]';
  weak.add(value);

  if (Array.isArray(value)) {
    const out = value
      .slice(0, SANITIZE_MAX_ARRAY)
      .map((v) => sanitizeForExport(v, weak, d + 1));
    if (value.length > SANITIZE_MAX_ARRAY) {
      out.push(`…+${value.length - SANITIZE_MAX_ARRAY} more`);
    }
    return out;
  }

  const out = {};
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length && i < SANITIZE_MAX_KEYS; i++) {
    const k = keys[i];
    if (k.startsWith('__react')) continue;
    try {
      out[k] = sanitizeForExport(value[k], weak, d + 1);
    } catch (_) {
      out[k] = '[Unserializable]';
    }
  }
  if (keys.length > SANITIZE_MAX_KEYS) {
    out['…'] = `+${keys.length - SANITIZE_MAX_KEYS} keys`;
  }
  return out;
}

/** Deep-clone to plain data, then stringify — never pass host objects to JSON.stringify. */
function safeJsonStringify(obj) {
  return JSON.stringify(sanitizeForExport(obj), null, 2);
}

function syncSessionRecording() {
  sessionRecording = logLevel >= LOG.select || observing;
}

function recordSessionLog(level, args) {
  if (!sessionRecording) return;
  const entry = sanitizeForExport({
    t: Date.now() - sessionStartedAt,
    level: LOG_NAME[level] ?? 'unknown',
  });
  if (args.length === 0) {
    entry.msg = '';
  } else if (args.length === 1) {
    if (typeof args[0] === 'string') entry.msg = args[0];
    else entry.data = sanitizeForExport(args[0]);
  } else if (typeof args[0] === 'string') {
    entry.msg = args[0];
    entry.data =
      args.length === 2
        ? sanitizeForExport(args[1])
        : sanitizeForExport(args.slice(1));
  } else {
    entry.data = sanitizeForExport(args);
  }
  sessionLog.push(entry);
  if (sessionLog.length > SESSION_LOG_MAX) sessionLog.shift();
}

function buildExportPayload() {
  return {
    exportedAt: new Date().toISOString(),
    phase: capturePhase,
    sessionMs: Date.now() - sessionStartedAt,
    debug: logLevelName(),
    enabled,
    observing,
    recording: sessionRecording,
    entryCount: sessionLog.length,
    entries: sessionLog.map((e) => sanitizeForExport(e)),
    state: buildReport(),
  };
}

function storeExportArchive(payload, text) {
  if (payload?.phase === 'baseline') {
    debugApi.lastBaselineExport = payload;
    debugApi.lastBaselineJson = text;
  } else if (payload?.phase === 'enhanced') {
    debugApi.lastEnhancedExport = payload;
    debugApi.lastEnhancedJson = text;
  }
}

function exportLog() {
  return sanitizeForExport(buildExportPayload());
}

function clearSessionLog() {
  sessionLog.length = 0;
  sessionStartedAt = Date.now();
}

function copyLog() {
  const payload = exportLog();
  let text;
  try {
    text = safeJsonStringify(payload);
  } catch (e) {
    text = JSON.stringify({
      error: 'copyLog failed',
      message: String(e?.message || e),
      entryCount: sessionLog.length,
    });
    debugApi.lastExport = { error: String(e?.message || e), entryCount: sessionLog.length };
    debugApi.lastExportJson = text;
    console.log('[tulbelt:fuzzy:main] copyLog failed:', e?.message || e);
    return debugApi.lastExport;
  }
  debugApi.lastExport = payload;
  debugApi.lastExportJson = text;
  storeExportArchive(payload, text);
  const copiedMsg =
    '[tulbelt:fuzzy:main] copied session log (' +
    (payload.phase || 'session') +
    ', ' +
    (payload.entryCount ?? sessionLog.length) +
    ' entries). Use lastExportJson';
  if (typeof copy === 'function') {
    try {
      copy(text);
      console.log(copiedMsg);
      return payload;
    } catch (_) {}
  }
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => {
      console.log(copiedMsg);
      return payload;
    });
  }
  console.log(
    '[tulbelt:fuzzy:main] copy(__tulbeltFuzzy.lastExportJson) — do not JSON.stringify(lastExport)',
  );
  return payload;
}

function setLogLevel(next) {
  if (next === undefined) {
    logLevel = logLevel >= LOG.all ? LOG.off : logLevel + 1;
  } else if (typeof next === 'boolean') {
    logLevel = next ? LOG.all : LOG.off;
  } else if (typeof next === 'number' && next >= 0 && next <= LOG.all) {
    logLevel = next;
  } else if (typeof next === 'string') {
    const key = next.toLowerCase();
    if (key in LOG) logLevel = LOG[key];
    else if (key === 'on' || key === 'true') logLevel = LOG.all;
    else if (key === 'false') logLevel = LOG.off;
  }
  syncSessionRecording();
  return logLevelName();
}

function logAt(minLevel, ...args) {
  recordSessionLog(minLevel, args);
  if (logLevel < minLevel) return;
  try { console.log('[tulbelt:fuzzy:main]', ...args); } catch (_) {}
}

function log(...args) {
  logAt(LOG.all, ...args);
}

const POPPER_SEL = '[data-testid="popper"]';
const EDITOR_SEL = '[data-testid="expression-editor-input"]';
const SAVE_BTN_SEL = '[data-testid="expression-editor-save-button"]';
const SAVE_HINT_ATTR = 'data-tulbelt-save-shortcut-hint';
const LIST_SEL = '.ReactVirtualized__List';
const NATIVE_ROW_SEL = '.ReactVirtualized__Grid__innerScrollContainer > div';

let enabled = false;
let docObserver = null;
let pendingScan = false;
const popperState = new WeakMap();

// ---------- React fiber access ----------
// React's fiber expando key varies:
//   * React 16/17/18 — `__reactFiber$<rand>` (host) / `__reactContainer$<rand>` (root)
//   * React 15-      — `__reactInternalInstance$<rand>`
// Use `getOwnPropertyNames` rather than `Object.keys` so non-enumerable
// expandos (which some bundlers / dev-tool patches produce) are still found.
const FIBER_PREFIXES = [
  '__reactFiber$',
  '__reactInternalInstance$',
  '__reactContainer$',
];
function fiberOf(node) {
  if (!node) return null;
  let keys;
  try { keys = Object.getOwnPropertyNames(node); } catch (_) { return null; }
  for (const k of keys) {
    for (const prefix of FIBER_PREFIXES) {
      if (k.startsWith(prefix)) {
        const v = node[k];
        if (v) return v;
      }
    }
  }
  return null;
}

// Climb to the nearest ancestor (or self) that has a fiber. The
// `.ReactVirtualized__List` element is from a wrapper component; in some
// build configurations the fiber lives on a parent host element instead.
function fiberOfNearestHost(node) {
  let n = node;
  let i = 0;
  while (n && i++ < 6) {
    const f = fiberOf(n);
    if (f) return { fiber: f, host: n };
    n = n.parentElement;
  }
  return null;
}

// Diagnostic — dump every expando-looking key on the node so we can see
// what React (if any) is actually attaching.
function reactKeysOn(node) {
  if (!node) return [];
  let keys;
  try { keys = Object.getOwnPropertyNames(node); } catch (_) { return []; }
  return keys.filter((k) => k.startsWith('__'));
}

function* walkUp(fiber) {
  let f = fiber;
  for (let i = 0; f && i < 200; i++) {
    yield f;
    f = f.return;
  }
}

// Descend into a fiber's children/siblings up to `maxDepth` levels.
// Sibling traversal stays at the same depth; child traversal increments.
function* walkDown(fiber, maxDepth = 4) {
  if (!fiber) return;
  function* recurse(f, depth) {
    if (!f) return;
    yield f;
    if (depth >= maxDepth) return;
    if (f.child) yield* recurse(f.child, depth + 1);
    if (f.sibling) yield* recurse(f.sibling, depth);
  }
  if (fiber.child) yield* recurse(fiber.child, 1);
}

function arrayLooksLikeOptions(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const first = arr[0];
  if (typeof first === 'string') return true;
  if (typeof first !== 'object' || first === null) return false;
  for (const k of ['label', 'displayName', 'display', 'name', 'text', 'value', 'path']) {
    if (typeof first[k] === 'string') return true;
  }
  return false;
}

// Walk the fiber chain (up + a few levels down at each ancestor) and
// collect every options-shaped array we can see. We surface:
//
//   * master — LARGEST options array. Tulip's full suggestion catalog for
//     this instance (size varies with workspace fields, apps, functions).
//   * all — every option-array we found, with fiber + source key, so the
//     debug API can dump them for inspection.
//
// Master is returned with `{fiber, key}` so callers can cheaply re-read the
// live value each render (Tulip's immutable updates change the array
// reference at every keystroke).
function findLists(startFiber) {
  const all = [];
  const seenFibers = new Set();
  const consider = (v, fiber, key) => {
    if (!arrayLooksLikeOptions(v)) return;
    all.push({ list: v, fiber, key });
  };
  const examine = (f) => {
    if (!f || seenFibers.has(f)) return;
    seenFibers.add(f);
    const props = f.memoizedProps;
    if (props && typeof props === 'object') {
      for (const k of Object.keys(props)) {
        consider(props[k], f, { kind: 'props', name: k });
      }
    }
    let hook = f.memoizedState;
    for (let depth = 0; hook && depth < 50; depth++) {
      const v = hook.memoizedState;
      consider(v, f, { kind: 'hook', name: `state[${depth}]` });
      // useMemo / useCallback / etc. store `[value, deps]`; check the value too.
      if (Array.isArray(v) && v.length === 2 && Array.isArray(v[1])) {
        consider(v[0], f, { kind: 'memo', name: `state[${depth}]` });
      }
      hook = hook.next;
    }
  };
  for (const f of walkUp(startFiber)) {
    examine(f);
    for (const child of walkDown(f, 3)) examine(child);
  }

  let master = null;
  for (const cand of all) {
    if (!master || cand.list.length > master.list.length) master = cand;
  }

  return { master, all };
}

// Cheap re-read for a previously-located list. Tulip almost always replaces
// the array reference on each render (immutable update), so the source we
// recorded at attach time is what we want to read live.
function readArrayFrom(source) {
  if (!source) return null;
  const { fiber, key } = source;
  if (!fiber) return null;
  if (key.kind === 'props') {
    const v = fiber.memoizedProps?.[key.name];
    return arrayLooksLikeOptions(v) ? v : null;
  }
  if (key.kind === 'hook' || key.kind === 'memo') {
    const m = /state\[(\d+)\]/.exec(key.name);
    const idx = m ? Number(m[1]) : -1;
    if (idx < 0) return null;
    let hook = fiber.memoizedState;
    for (let i = 0; hook && i <= idx; i++) {
      if (i === idx) {
        const v = hook.memoizedState;
        if (key.kind === 'hook') return arrayLooksLikeOptions(v) ? v : null;
        if (Array.isArray(v) && v.length === 2 && Array.isArray(v[1])) {
          return arrayLooksLikeOptions(v[0]) ? v[0] : null;
        }
        return null;
      }
      hook = hook.next;
    }
  }
  return null;
}

const SELECT_KEYS = [
  // Tulip's actual handler name.
  'onSelection',
  // Other common shapes, kept as fallbacks.
  'onSelect',
  'onSelectItem',
  'onSelected',
  'onChoose',
  'onPick',
  'onItemClick',
  'onItemSelect',
  'onClickItem',
  'onSuggestionSelected',
  'select',
];

function findSelectHandler(startFiber, quiet = false) {
  const found = findSelectHandlerFiber(startFiber);
  if (!found) return null;
  if (!quiet) {
    log(
      'select handler:',
      found.key,
      'on',
      found.fiber.type?.displayName || found.fiber.type?.name || found.fiber.type,
    );
  }
  return found.fn;
}

function findSelectHandlerFiber(startFiber) {
  for (const f of walkUp(startFiber)) {
    const p = f.memoizedProps;
    if (!p || typeof p !== 'object') continue;
    for (const k of SELECT_KEYS) {
      if (typeof p[k] === 'function') {
        return { fiber: f, key: k, fn: p[k] };
      }
    }
  }
  return null;
}

function getLabel(item) {
  if (typeof item === 'string') return item;
  if (typeof item !== 'object' || item === null) return String(item);
  for (const k of [
    'displayName',
    'display',
    'label',
    'fullPath',
    'path',
    'text',
    'name',
    'value',
  ]) {
    if (typeof item[k] === 'string') return item[k];
  }
  return JSON.stringify(item);
}

function valueLooksLikeOption(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (typeof v.value !== 'string') return false;
  if (typeof v.type !== 'string' && typeof v.display !== 'string') return false;
  if (
    typeof v.display !== 'string' &&
    typeof v.displayName !== 'string' &&
    typeof v.label !== 'string' &&
    typeof v.text !== 'string' &&
    typeof v.name !== 'string'
  ) {
    return false;
  }
  return true;
}

function labelsMatch(a, b) {
  const x = (a ?? '').trim();
  const y = (b ?? '').trim();
  if (!x || !y) return false;
  return x === y;
}

function getControllerSelectionRange(ctrl) {
  if (!ctrl) return null;
  try {
    const anchor = ctrl.getSelectionAnchor?.();
    const focus = ctrl.getSelectionFocus?.();
    if (typeof anchor === 'number' && typeof focus === 'number') {
      return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
    }
  } catch (_) {}
  return null;
}

// Find the React handler Tulip's virtualized row would fire on a real click.
function findRowClickHandler(rowEl) {
  const f = fiberOf(rowEl);
  if (!f) return null;
  let fallback = null;
  const stack = [f];
  let visits = 0;
  while (stack.length && visits++ < 60) {
    const fib = stack.pop();
    if (!fib) continue;
    const p = fib.memoizedProps;
    if (p && typeof p === 'object') {
      let hasItem = false;
      for (const k of Object.keys(p)) {
        if (valueLooksLikeOption(p[k])) hasItem = true;
      }
      for (const evt of ['onClick', 'onMouseDown']) {
        if (typeof p[evt] === 'function') {
          if (hasItem) return p[evt];
          if (!fallback) fallback = p[evt];
        }
      }
    }
    if (fib.child) stack.push(fib.child);
    if (fib.sibling) stack.push(fib.sibling);
  }
  return fallback;
}

function optionFromProps(p) {
  if (!p || typeof p !== 'object') return null;
  for (const k of Object.keys(p)) {
    if (valueLooksLikeOption(p[k])) return { key: k, item: p[k] };
  }
  for (const k of ['item', 'option', 'data', 'row', 'suggestion']) {
    const v = p[k];
    if (valueLooksLikeOption(v)) return { key: k, item: v };
  }
  return null;
}

function findRowItemNear(node) {
  let cur = node;
  for (let depth = 0; cur && depth < 14; depth++) {
    const f = fiberOf(cur);
    if (f) {
      const stack = [f];
      let visits = 0;
      while (stack.length && visits++ < 48) {
        const fib = stack.pop();
        if (!fib) continue;
        const hit = optionFromProps(fib.memoizedProps);
        if (hit) return hit;
        if (fib.child) stack.push(fib.child);
        if (fib.sibling) stack.push(fib.sibling);
        if (fib.return) stack.push(fib.return);
      }
    }
    cur = cur.parentElement;
  }
  return null;
}

function findItemByRowLabel(state, rowText) {
  const label = (rowText ?? '').trim();
  if (!label) return null;
  const master = readArrayFrom(state.masterSource);
  if (!Array.isArray(master)) return null;
  const idx = masterIndexInList(master, { value: label });
  if (idx < 0) {
    const byLabel = master.find((row) => labelsMatch(getLabel(row), label));
    return byLabel ?? null;
  }
  return master[idx];
}

// Replicate a native list-row click: Tulip's onClick closes over the item and
// computes indexes from the live editor caret at invoke time.
function rowMatchesItem(rowEl, item) {
  const label = getLabel(item);
  const text = (rowEl.textContent ?? '').trim();
  if (labelsMatch(text, label)) return true;
  const targetValue = item && typeof item === 'object' ? item.value : undefined;
  if (!targetValue) return false;
  const found = findRowItemNear(rowEl);
  return !!(found?.item && found.item.value === targetValue);
}

function invokeNativeListRowSelect(state, item) {
  const list = state.list;
  if (!list) return false;
  const rowEls = list.querySelectorAll(NATIVE_ROW_SEL);
  const stubEvent = {
    preventDefault() {},
    stopPropagation() {},
    currentTarget: null,
    target: null,
    nativeEvent: { stopImmediatePropagation() {} },
  };
  for (const rowEl of rowEls) {
    if (!rowMatchesItem(rowEl, item)) continue;
    const handler = findRowClickHandler(rowEl);
    if (!handler) continue;
    stubEvent.currentTarget = rowEl;
    stubEvent.target = rowEl;
    try {
      handler(stubEvent);
      return true;
    } catch (e) {
      logAt(LOG.select, 'native row handler threw:', e?.message || e);
    }
  }
  return false;
}

function itemsMatch(a, b) {
  if (!a || !b) return false;
  if (typeof a === 'object' && typeof b === 'object') {
    if (a.value && b.value && a.value === b.value) return true;
    return labelsMatch(getLabel(a), getLabel(b));
  }
  return labelsMatch(String(a), getLabel(b));
}

// Row onClick from fiber when the DOM row exists but matching failed, or after scroll.
function invokeNativeRowSelectFromFiber(state, item) {
  const found = fiberOfNearestHost(state.list);
  if (!found) return false;
  const stubEvent = {
    preventDefault() {},
    stopPropagation() {},
    currentTarget: null,
    target: null,
    nativeEvent: { stopImmediatePropagation() {} },
  };
  let handler = null;
  let host = null;
  const stack = [found.fiber];
  let visits = 0;
  while (stack.length && visits++ < 800) {
    const fib = stack.pop();
    if (!fib) continue;
    const p = fib.memoizedProps;
    if (p && typeof p === 'object') {
      const hit = optionFromProps(p);
      if (hit && itemsMatch(hit.item, item)) {
        for (const evt of ['onClick', 'onMouseDown']) {
          if (typeof p[evt] === 'function') {
            handler = p[evt];
            host = fib.stateNode;
            break;
          }
        }
        if (handler) break;
      }
    }
    if (fib.child) stack.push(fib.child);
    if (fib.sibling) stack.push(fib.sibling);
  }
  if (!handler) return false;
  try {
    stubEvent.currentTarget = host || state.list;
    stubEvent.target = stubEvent.currentTarget;
    handler(stubEvent);
    return true;
  } catch (e) {
    logAt(LOG.select, 'fiber row handler threw:', e?.message || e);
    return false;
  }
}

function invokeNativeSelect(state, item) {
  return invokeNativeListRowSelect(state, item) || invokeNativeRowSelectFromFiber(state, item);
}

function logSelectAfter(state, label, beforeText, selectSource) {
  if (logLevel < LOG.select) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const tag =
        capturePhase === 'enhanced'
          ? `capture:pick→after:${selectSource}`
          : `[select→after:${selectSource}]`;
      const after = snapshotEditorText(state.editor);
      const pending = capturePendingSelection(state);
      logAt(LOG.select, tag, {
        picked: label,
        selectSource,
        before: beforeText,
        after,
        delta: diffAround(beforeText ?? '', after ?? ''),
        pending,
        indexPreview: captureIndexPreview(state.editor, pending),
        controller: captureControllerContext(state.editor),
      });
    });
  });
}

function isFieldItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.type === 'field') return true;
  return typeof item.value === 'string' && item.value.trimStart().startsWith('@');
}

// Tulip field suggestions use a leading @ and trailing space in `value`.
function fieldReferenceText(item) {
  const raw =
    item && typeof item === 'object' && typeof item.value === 'string'
      ? item.value
      : getLabel(item);
  const t = (raw ?? '').trimEnd();
  if (!t) return '';
  const withAt = t.startsWith('@') ? t : `@${t}`;
  return withAt.endsWith(' ') ? withAt : `${withAt} `;
}

function editorHasPrimeArtifacts(editor) {
  return (snapshotEditorText(editor) ?? '').includes('[object Object]');
}

function partialFilterQueryStillVisible(editor, pending) {
  const q = pending?.filterQuery;
  if (!q) return false;
  const t = snapshotEditorText(editor) ?? '';
  return t.includes(`+ ${q}`) || t.endsWith(q);
}

function fieldSuffix(item) {
  const needle = fieldReferenceText(item).replace(/^@/, '').trim();
  const marker = 'Current ';
  const i = needle.indexOf(marker);
  return i >= 0 ? needle.slice(i + marker.length).trim() : needle;
}

function fieldChipContains(editor, item) {
  const suffix = fieldSuffix(item);
  if (!suffix) return false;
  for (const span of contentSpans(editor)) {
    if (!spanIsFieldChip(span)) continue;
    const st = (span.textContent ?? '').replace(/\u200b/g, '').trim();
    if (st.endsWith(suffix) || st.includes(suffix)) return true;
  }
  return false;
}

function simulateEditorKeys(editor, parts) {
  if (!editor) return false;
  try {
    editor.focus();
  } catch (_) {}
  for (const part of parts) {
    if (part === 'Backspace') {
      const e = { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true, cancelable: true };
      editor.dispatchEvent(new KeyboardEvent('keydown', e));
      editor.dispatchEvent(new KeyboardEvent('keyup', e));
      continue;
    }
    for (const ch of part) {
      const base = { bubbles: true, cancelable: true, composed: true, key: ch };
      editor.dispatchEvent(new KeyboardEvent('keydown', { ...base, keyCode: ch.charCodeAt(0) }));
      try {
        editor.dispatchEvent(
          new InputEvent('beforeinput', { ...base, inputType: 'insertText', data: ch }),
        );
        editor.dispatchEvent(new InputEvent('input', { ...base, inputType: 'insertText', data: ch }));
      } catch (_) {}
      editor.dispatchEvent(new KeyboardEvent('keyup', { ...base, keyCode: ch.charCodeAt(0) }));
    }
  }
  return true;
}

// Try typing the full `@…` path (Tulip parses it). Synthetic key events often only
// reach delete — execCommand is attempted first.
function typeFieldReference(state, item, pending) {
  const text = fieldReferenceText(item);
  if (!text || !pending) return false;
  const start = pending.tokenStart;
  const end = pendingDisplayEnd(pending);
  if (typeof start !== 'number' || typeof end !== 'number' || end < start) return false;

  const editor = state.editor;
  try {
    editor.focus();
  } catch (_) {}

  let method = 'keys';
  for (let i = 0; i < end - start; i++) {
    try {
      document.execCommand('deleteBackward', false, null);
    } catch (_) {}
  }
  try {
    if (document.execCommand('insertText', false, text)) method = 'execCommand';
  } catch (_) {}
  if (method === 'keys') {
    const parts = [];
    for (let i = 0; i < end - start; i++) parts.push('Backspace');
    parts.push(text);
    simulateEditorKeys(editor, parts);
  }
  logAt(LOG.select, 'typed field reference', {
    text: text.slice(0, 80),
    tokenSpan: end - start,
    method,
  });
  return true;
}

function fieldReferenceTypedOk(editor, item, pending) {
  if (editorHasPrimeArtifacts(editor)) return false;
  if (partialFilterQueryStillVisible(editor, pending)) return false;
  return fieldChipContains(editor, item);
}

function cleanupPrimeArtifacts(editor) {
  if (!editorHasPrimeArtifacts(editor)) return;
  const junk = '[object Object]';
  const parts = [];
  for (let i = 0; i < junk.length; i++) parts.push('Backspace');
  simulateEditorKeys(editor, parts);
}

function selectItemViaOnSelection(state, item, pending, ctrl, beforeText, label) {
  cleanupPrimeArtifacts(state.editor);
  const { indexes, source: indexSource } = resolveFuzzyControllerIndexes(
    state.editor,
    ctrl,
    pending,
  );
  if (!indexes) {
    logAt(LOG.select, 'cannot select — no controller indexes', { label, pending });
    return;
  }
  const payload = buildFuzzyOnSelectPayload(item, indexes);
  logAt(LOG.select, 'select via onSelection (fuzzy-only)', {
    label,
    selectSource: indexSource,
    indexes,
    displayIndexes: {
      start: pending?.tokenStart,
      end: pendingDisplayEnd(pending),
    },
    filterQuery: pending?.filterQuery,
    tokenStart: pending?.tokenStart,
    caretOffset: pending?.caretOffset,
    controllerCursor: pending?.controllerCursor,
    serializedLen: readControllerString(ctrl, state.editor)?.length ?? null,
  });
  try {
    state.onSelect(payload);
    try { state.editor.focus(); } catch (_) {}
    try { ctrl.focus?.(); } catch (_) {}
    logSelectAfter(state, label, beforeText, 'onSelection');
  } catch (e) {
    logAt(LOG.select, 'onSelect threw:', e?.message || e, 'payload=', {
      value: payload?.value,
      type: payload?.type,
    });
  }
}

// ---------- filter ----------
// Case-insensitive substring on the item's label against the whole master
// list. We deliberately do NOT honor Tulip's "current context" gating
// (fields-only when prefixed with `@`, functions/operators otherwise) —
// that gating is exactly what this override exists to bypass. Users want
// to type a bare `User.ID` mid-formula and reach `@Table record.Current
// User.ID` without having to remember the `@` opener, and they want to
// type `floor` from anywhere and still reach the `Floor()` function.
//
// Two small wrinkles:
//   * Leading `@` on field labels is stripped from the haystack, so a
//     bare query `user.id` still matches a field label `@…user.id…`.
//     (The query's own leading `@` is also stripped before lowercasing.)
//   * If the user DID type a leading `@`, we treat that as a strong "I
//     want a field" signal and restrict results to items whose label
//     starts with `@`. So `@` alone narrows to the first MAX_RESULTS
//     fields, which is the natural behavior for the field opener.
//
// Master-list order is preserved — Tulip's own ordering is already
// meaningful (grouped by category) so functions/operators tend to surface
// before fields for ambiguous needles.
function isHiddenLabel(lowerLabel) {
  for (const p of HIDDEN_LABEL_PREFIXES) {
    if (lowerLabel.startsWith(p)) return true;
  }
  return false;
}

function fuzzyFilter(items, query) {
  const wantField = query.startsWith('@');
  const needle = (wantField ? query.slice(1) : query).toLowerCase();
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const label = getLabel(item);
    if (wantField && !label.startsWith('@')) continue;
    const lower = label.toLowerCase();
    if (isHiddenLabel(lower)) continue;
    if (needle) {
      const haystack = lower.startsWith('@') ? lower.slice(1) : lower;
      if (!haystack.includes(needle)) continue;
    }
    out.push(item);
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

// Cheap key so render() can tell when Enter should target a new first row.
function filteredListKey(query, items) {
  if (!items.length) return `${query}|0`;
  const first = items[0];
  const last = items[items.length - 1];
  const fv =
    first && typeof first === 'object' && typeof first.value === 'string'
      ? first.value
      : getLabel(first);
  const lv =
    last && typeof last === 'object' && typeof last.value === 'string'
      ? last.value
      : getLabel(last);
  return `${query}|${items.length}|${fv}|${lv}`;
}

// ---------- styles ----------
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* visibility:hidden keeps row geometry for Tulip's Example/docs popper;
       display:none collapses the list and pins that popper at (0,0). */
    [${LIST_HOST_ATTR}] {
      position: relative;
    }
    [${HIDE_REACT_LIST_ATTR}="true"] {
      visibility: hidden !important;
      pointer-events: none !important;
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      z-index: 0 !important;
    }
    .${OVERLAY_CLASS} {
      position: relative;
      z-index: 1;
      box-sizing: border-box;
      overflow: auto;
      font-family: "Noto Sans", sans-serif;
      font-size: 13px;
      color: inherit;
      background: transparent;
    }
    .${ROW_CLASS} {
      box-sizing: border-box;
      height: 25px;
      padding: 3px 8px;
      line-height: 19px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .${ROW_CLASS}:hover {
      background: rgba(28, 105, 225, 0.10);
    }
    .${FN_ROW_CLASS} {
      text-transform: uppercase;
    }
    .${SELECTED_CLASS} {
      background: rgba(28, 105, 225, 0.20) !important;
    }
    .${EMPTY_CLASS} {
      padding: 8px 12px;
      color: rgba(0, 0, 0, 0.5);
      font-style: italic;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
}

// ---------- editor text + range ----------
// DOM token under the caret drives fuzzyFilter. Native picks use
// invokeNativeListRowSelect; fuzzy-only picks use the same frozen token span.
//
// IMPORTANT: whitespace and `.` are intentionally NOT separators. Tulip
// field labels routinely contain spaces and dots
// (`@Table record.Current User.Date Created`), so we need a fuzzy query
// like `date c` to be able to reach them. The hard separators are the
// expression operators / brackets / quotes — `+` is the primary one in
// practice, but the others matter for non-trivial formulas.
const HARD_SEP_RE = /[+\-*/(),;"'=!<>%&|^~]/;
const WS_RE = /\s/;

// Tulip's expression editor is NOT a real contenteditable. It mirrors the
// formula in `.cursorContainer` (with `<span class="cursor">`) and `.content`
// (with `data-index` on each segment). The cursor often sits *inside* a field
// span, and a TreeWalker that only sums text nodes can report the offset at
// the end of the first chip instead of the active segment.
function chooseCursorEl(cursorContainer) {
  const cursorNodes = Array.from(cursorContainer.querySelectorAll('.cursor'));
  if (cursorNodes.length === 0) return null;
  let cursorEl = null;
  for (let i = cursorNodes.length - 1; i >= 0; i--) {
    const node = cursorNodes[i];
    let visible = false;
    try {
      const rects = typeof node.getClientRects === 'function' ? node.getClientRects() : null;
      visible = !!rects && rects.length > 0;
    } catch (_) {}
    if (visible) {
      cursorEl = node;
      break;
    }
  }
  if (!cursorEl) cursorEl = cursorNodes[cursorNodes.length - 1];
  return cursorEl;
}

function cursorContainerSegment(cursorContainer, cursorEl) {
  let segment = cursorEl.parentElement;
  while (segment && segment.parentElement !== cursorContainer) {
    segment = segment.parentElement;
  }
  return segment;
}

function contentSpans(editor) {
  const content = editor.querySelector('.content');
  if (!content) return [];
  return Array.from(content.children).filter(
    (el) => el.tagName === 'SPAN' && el.hasAttribute('data-index'),
  );
}

function caretOffsetFromGeometry(editor, cursorEl) {
  if (!cursorEl) return null;
  let cursorRect;
  try {
    cursorRect = cursorEl.getBoundingClientRect();
  } catch (_) {
    return null;
  }
  const cx = cursorRect.left;
  const cy = cursorRect.top + cursorRect.height / 2;
  const spans = contentSpans(editor);
  if (spans.length === 0) return null;

  let hitSpan = null;
  let hitRect = null;
  let bestDist = Infinity;
  for (const span of spans) {
    let rects;
    try {
      rects = span.getClientRects();
    } catch (_) {
      continue;
    }
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (!r.width && !r.height) continue;
      const onLine = cy >= r.top - 4 && cy <= r.bottom + 4;
      if (!onLine) continue;
      let xDist = 0;
      if (cx < r.left) xDist = r.left - cx;
      else if (cx > r.right) xDist = cx - r.right;
      const dist = xDist;
      if (dist < bestDist) {
        bestDist = dist;
        hitSpan = span;
        hitRect = r;
      }
    }
  }
  if (!hitSpan || !hitRect) return null;

  const base = parseInt(hitSpan.getAttribute('data-index'), 10);
  if (Number.isNaN(base)) return null;
  const spanText = (hitSpan.textContent ?? '').replace(/\u200b/g, '');
  if (!spanText.length) return base;
  const ratio = Math.max(0, Math.min(1, (cx - hitRect.left) / Math.max(hitRect.width, 1)));
  return base + Math.round(ratio * spanText.length);
}

function offsetInCursorSegment(segment, cursorEl) {
  const segText = (segment.textContent ?? '').replace(/\u200b/g, '');
  let offsetInSeg = segText.length;
  const walker = document.createTreeWalker(segment, NodeFilter.SHOW_ALL);
  let node = walker.nextNode();
  let seen = 0;
  while (node) {
    if (node === cursorEl) {
      offsetInSeg = seen;
      break;
    }
    if (node.nodeType === Node.TEXT_NODE) seen += (node.nodeValue ?? '').length;
    node = walker.nextNode();
  }
  return offsetInSeg;
}

function caretOffsetFromDom(editor, cursorEl, cursorContainer) {
  const segment = cursorContainerSegment(cursorContainer, cursorEl);
  const spans = contentSpans(editor);
  if (segment) {
    const segText = (segment.textContent ?? '').replace(/\u200b/g, '');
    const containerKids = Array.from(cursorContainer.childNodes).filter(
      (n) => n.nodeType === Node.ELEMENT_NODE,
    );
    const segIndex = containerKids.indexOf(segment);

    const spanFromIndex =
      segIndex >= 0 && segIndex < spans.length ? spans[segIndex] : null;
    const spanFromText = spans.find((span) => {
      const spanText = (span.textContent ?? '').replace(/\u200b/g, '');
      return spanText === segText || (segText && spanText.startsWith(segText));
    });
    const span = spanFromText || spanFromIndex;

    if (span) {
      const base = parseInt(span.getAttribute('data-index'), 10);
      if (!Number.isNaN(base)) {
        return base + offsetInCursorSegment(segment, cursorEl);
      }
    }
  }

  let offset = 0;
  const walker = document.createTreeWalker(cursorContainer, NodeFilter.SHOW_ALL);
  let node = walker.nextNode();
  while (node) {
    if (node === cursorEl) return offset;
    if (node.nodeType === Node.TEXT_NODE) offset += node.nodeValue.length;
    node = walker.nextNode();
  }
  return null;
}

function caretOffsetIn(editor) {
  const content = editor.querySelector('.content');
  const cursorContainer = editor.querySelector('.cursorContainer');
  if (!content || !cursorContainer) return null;

  const cursorEl = chooseCursorEl(cursorContainer);
  if (!cursorEl) return null;

  const dom = caretOffsetFromDom(editor, cursorEl, cursorContainer);
  const geom = caretOffsetFromGeometry(editor, cursorEl);
  if (geom == null) return dom;
  if (dom == null) return geom;

  const activeDom = spanAtCaret(editor, dom);
  const activeGeom = spanAtCaret(editor, geom);
  const domInField =
    activeDom && spanIsFieldChip(activeDom.span) && dom > activeDom.start && dom <= activeDom.end;
  const geomInField =
    activeGeom &&
    spanIsFieldChip(activeGeom.span) &&
    geom > activeGeom.start &&
    geom <= activeGeom.end;
  // After deleting a chip, cursorContainer segment index can drift into the
  // next field chip while the visible caret sits in the gap — trust geometry.
  if (domInField && !geomInField) return geom;
  if (!domInField && geomInField) return dom;
  // DOM mapping used to jump to segment end (e.g. `(Event)|` while typing `Event`).
  if (Math.abs(dom - geom) === 1 && geom < dom) return geom;
  if (Math.abs(dom - geom) > 1) return geom;

  const ctrl = findController(editor);
  if (ctrl) {
    const ctrlPos = readControllerCursor(ctrl);
    const mapped = mapControllerPosToDisplay(editor, ctrl, ctrlPos);
    if (mapped != null) {
      const activeDom = spanAtCaret(editor, dom);
      const activeMapped = spanAtCaret(editor, mapped);
      const domInFieldChip =
        activeDom &&
        spanIsFieldChip(activeDom.span) &&
        dom > activeDom.start &&
        dom <= activeDom.end;
      const mappedInFieldChip =
        activeMapped &&
        spanIsFieldChip(activeMapped.span) &&
        mapped > activeMapped.start &&
        mapped <= activeMapped.end;
      if (domInFieldChip && !mappedInFieldChip) return mapped;
      if (dom == null) return mapped;
    }
  }
  return dom;
}

// Tulip often updates cursorContainer before .content mirrors typed text
// (e.g. function arguments like totext(event)).
function tokenQueryFromCursorSegment(editor) {
  const cursorContainer = editor.querySelector('.cursorContainer');
  if (!cursorContainer) return null;
  const cursorEl = chooseCursorEl(cursorContainer);
  if (!cursorEl) return null;
  const segment = cursorContainerSegment(cursorContainer, cursorEl);
  if (!segment) return null;
  const segText = (segment.textContent ?? '').replace(/\u200b/g, '');

  const offsetInSeg = offsetInCursorSegment(segment, cursorEl);
  let localStart = offsetInSeg;
  while (localStart > 0 && !HARD_SEP_RE.test(segText[localStart - 1])) localStart--;
  while (localStart < offsetInSeg && WS_RE.test(segText[localStart])) localStart++;
  return segText.slice(localStart, offsetInSeg);
}

function mapControllerPosToDisplay(editor, ctrl, ctrlPos) {
  if (typeof ctrlPos !== 'number' || ctrlPos < 0) return null;
  const serialized = readControllerString(ctrl, editor);
  if (!serialized || !controllerLooksSerialized(serialized)) return null;
  const segments = buildDisplayControllerSegments(editor, serialized);
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (ctrlPos < seg.c0 || ctrlPos > seg.c1) continue;
    if (seg.isField) {
      if (ctrlPos === seg.c0) return seg.d0;
      if (ctrlPos === seg.c1) return seg.d1;
      return null;
    }
    return seg.d0 + (ctrlPos - seg.c0);
  }
  const last = segments[segments.length - 1];
  if (last && ctrlPos > last.c1) return last.d1 + (ctrlPos - last.c1);
  return null;
}

function spanAtCaret(editor, caret) {
  const spans = contentSpans(editor);
  if (spans.length === 0 || caret == null) return null;
  for (let i = 0; i < spans.length; i++) {
    const start = parseInt(spans[i].getAttribute('data-index'), 10);
    if (Number.isNaN(start)) continue;
    const spanText = (spans[i].textContent ?? '').replace(/\u200b/g, '');
    const nextStart =
      i + 1 < spans.length ? parseInt(spans[i + 1].getAttribute('data-index'), 10) : null;
    const end =
      nextStart != null && !Number.isNaN(nextStart)
        ? nextStart
        : start + spanText.length;
    if (caret >= start && caret <= end) {
      return { span: spans[i], start, end };
    }
  }
  return null;
}

function getCurrentRange(editor) {
  const content = editor.querySelector('.content');
  const text = content?.textContent ?? '';
  let caret = caretOffsetIn(editor);
  if (caret == null || caret > text.length || caret < 0) caret = text.length;
  // Caret on the trailing edge of a committed field chip — user finished that
  // token (e.g. second Enter after picking a value in OBJECT({…})). Do not
  // walk the chip text as the fuzzy token or Enter re-selects and splices the
  // whole formula.
  const chipAtCaret = spanAtCaret(editor, caret);
  if (
    chipAtCaret &&
    spanIsFieldChip(chipAtCaret.span) &&
    caret === chipAtCaret.end &&
    caret > chipAtCaret.start
  ) {
    return { text, query: '', start: caret, end: caret, caret };
  }
  // Walk BACK from the caret to find the token's start. Stop at the
  // previous hard separator (`+`, `-`, `(`, `'`, …). Spaces are NOT
  // separators — see HARD_SEP_RE comment.
  let start = caret;
  while (start > 0 && !HARD_SEP_RE.test(text[start - 1])) start--;
  // Then skip any leading whitespace inside the token so that, e.g.,
  // `@Foo + @bar` makes the active token `@bar` (not ` @bar`); otherwise
  // selecting would also splice over the space after `+`.
  while (start < caret && WS_RE.test(text[start])) start++;
  // Do not walk back out of the segment that contains the caret (field chip,
  // string literal, or partial token being typed).
  const active = spanAtCaret(editor, caret);
  // Only clamp when the caret is inside the active span — not when typing
  // past a field chip (caret > active.end), which wrongly pulled "eve" into
  // the previous chip and overwrote Asset.ID.
  if (active && caret <= active.end) {
    // At the left edge of a chip the user may be replacing a deleted neighbor;
    // allow walking back past hard separators (e.g. `+`) into the gap.
    if (caret > active.start && start < active.start) start = active.start;
  }
  // Walk FORWARD from the caret to find the token's end, so selecting
  // replaces the WHOLE token under the cursor — not just the prefix the
  // user has already typed. (For the common case of caret-at-end, this
  // is a no-op.)
  let end = caret;
  while (end < text.length && !HARD_SEP_RE.test(text[end])) end++;
  if (active && caret <= active.end && end > active.end) end = active.end;

  let query = text.slice(start, caret);
  const segmentQuery = tokenQueryFromCursorSegment(editor);
  if (segmentQuery != null && segmentQuery !== query) {
    const useSegment =
      !query || segmentQuery.startsWith(query) || query.length < segmentQuery.length;
    if (useSegment) {
      query = segmentQuery;
      const hit = text.lastIndexOf(segmentQuery, caret);
      if (hit >= 0) {
        let newStart = hit;
        while (newStart > 0 && !HARD_SEP_RE.test(text[newStart - 1])) newStart--;
        while (newStart < hit && WS_RE.test(text[newStart])) newStart++;
        if (newStart <= hit) start = newStart;
      }
    }
  }
  return { text, query, start, end, caret };
}

// Editor controller — walk UP from the editor fiber (multiple instances exist).
function findController(editor) {
  const f = fiberOf(editor);
  if (!f) return null;
  const ok = (o) =>
    o &&
    typeof o === 'object' &&
    typeof o.focus === 'function' &&
    typeof o.getCursorPosition === 'function';
  for (const fib of walkUp(f)) {
    const sn = fib.stateNode;
    if (ok(sn)) return sn;
  }
  return null;
}

// Snapshot from getCurrentRange() — token span and filterQuery must share one call.
function pendingDisplayEnd(pending) {
  const caret = pending?.caretOffset;
  const tokenEnd = pending?.tokenEnd;
  if (typeof caret !== 'number') return typeof tokenEnd === 'number' ? tokenEnd : null;
  if (typeof tokenEnd === 'number') return Math.max(caret, tokenEnd);
  return caret;
}

function capturePendingSelection(state) {
  const range = state.currentRange;
  const ctrl = state.editor ? findController(state.editor) : null;
  return {
    filterQuery: range?.query ?? '',
    tokenStart: typeof range?.start === 'number' ? range.start : null,
    tokenEnd: typeof range?.end === 'number' ? range.end : null,
    caretOffset: typeof range?.caret === 'number' ? range.caret : null,
    selection: ctrl ? getControllerSelectionRange(ctrl) : null,
    controllerCursor: ctrl ? readControllerCursor(ctrl) : null,
  };
}

function refreshPendingSelection(state) {
  const range = getCurrentRange(state.editor);
  state.currentRange = range;
  return capturePendingSelection(state);
}

function readControllerCursor(ctrl) {
  if (!ctrl) return null;
  try {
    const p = ctrl.getCursorPosition();
    if (typeof p === 'number') return p;
  } catch (_) {}
  return null;
}

function tryReadSerializedString(v) {
  return typeof v === 'string' && controllerLooksSerialized(v) ? v : null;
}

function readControllerStringFromFiber(editor) {
  const f = fiberOf(editor);
  if (!f) return null;
  for (const fib of walkUp(f)) {
    const sn = fib.stateNode;
    if (sn && sn !== editor && typeof sn === 'object') {
      for (const k of ['value', 'text', 'expression', 'formula', 'editorValue']) {
        const hit = tryReadSerializedString(sn[k]);
        if (hit) return hit;
      }
      for (const method of ['getValue', 'getText', 'getEditorValue']) {
        try {
          const fn = sn[method];
          if (typeof fn === 'function') {
            const hit = tryReadSerializedString(fn());
            if (hit) return hit;
          }
        } catch (_) {}
      }
    }
    const props = fib.memoizedProps;
    if (props && typeof props === 'object') {
      for (const k of ['value', 'text', 'expression', 'formula', 'editorValue']) {
        const hit = tryReadSerializedString(props[k]);
        if (hit) return hit;
      }
    }
    let hook = fib.memoizedState;
    for (let i = 0; hook && i < 60; i++, hook = hook.next) {
      let v = hook.memoizedState;
      const hit = tryReadSerializedString(v);
      if (hit) return hit;
      if (v && typeof v === 'object') {
        const inner = tryReadSerializedString(v.value) || tryReadSerializedString(v.text);
        if (inner) return inner;
      }
      if (Array.isArray(v) && v.length === 2) {
        const hit2 = tryReadSerializedString(v[0]);
        if (hit2) return hit2;
      }
    }
  }
  return null;
}

function readControllerString(ctrl, editor) {
  if (ctrl) {
    for (const method of ['getValue', 'getText', 'getEditorValue', 'getSerializedValue']) {
      try {
        const fn = ctrl[method];
        if (typeof fn === 'function') {
          const hit = tryReadSerializedString(fn());
          if (hit) return hit;
        }
      } catch (_) {}
    }
    for (const k of ['value', 'text', 'serializedValue', 'editorValue']) {
      const hit = tryReadSerializedString(ctrl[k]);
      if (hit) return hit;
    }
  }
  if (editor) return readControllerStringFromFiber(editor);
  return null;
}

function controllerLooksSerialized(s) {
  return typeof s === 'string' && (s.includes('\u001f') || s.includes('field_{'));
}

function fieldBlobLengthAt(serialized, pos) {
  if (pos >= serialized.length) return 0;
  if (serialized[pos] !== '\u001f') {
    const next = serialized.indexOf('\u001f', pos);
    return next >= 0 ? next - pos : serialized.length - pos;
  }
  const after = pos + 1;
  if (serialized.startsWith('field_{', after)) {
    let j = serialized.indexOf('{', after);
    let depth = 0;
    while (j < serialized.length) {
      const ch = serialized[j];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      j++;
    }
    if (serialized[j] === '\u001f') j++;
    return j - pos;
  }
  const next = serialized.indexOf('\u001f', pos + 1);
  return next >= 0 ? next - pos : serialized.length - pos;
}

function buildDisplayControllerSegments(editor, serialized) {
  const segments = [];
  const spans = contentSpans(editor);
  let d = 0;
  let c = 0;
  for (const span of spans) {
    const text = (span.textContent ?? '').replace(/\u200b/g, '');
    const isField = spanIsFieldChip(span);
    const d0 = d;
    const d1 = d + text.length;
    const c0 = c;
    const c1 = c + (isField ? fieldBlobLengthAt(serialized, c) : text.length);
    segments.push({ d0, d1, c0, c1, isField });
    d = d1;
    c = c1;
  }
  const tail = editor.querySelector('.content')?.textContent ?? '';
  if (d < tail.length) {
    segments.push({
      d0: d,
      d1: tail.length,
      c0: c,
      c1: c + (tail.length - d),
      isField: false,
    });
  }
  return segments;
}

// When serialized value is unavailable, field blobs are ~11 chars longer than display.
function mapDisplayRangeHeuristic(editor, displayStart, displayEnd) {
  const spans = contentSpans(editor);
  let ctrl = 0;
  let d = 0;
  let ctrlStart = null;
  let ctrlEnd = null;
  for (const span of spans) {
    const text = (span.textContent ?? '').replace(/\u200b/g, '');
    const isField = spanIsFieldChip(span);
    const d0 = d;
    const d1 = d + text.length;
    const c0 = ctrl;
    const cLen = isField ? text.length + 11 + Math.max(0, text.length - 24) : text.length;
    const c1 = ctrl + cLen;
    if (displayStart >= d0 && displayStart < d1) {
      if (isField && displayStart > d0) return null;
      ctrlStart = c0 + (displayStart - d0);
    }
    if (displayEnd > d0 && displayEnd <= d1) {
      if (isField && displayEnd < d1) return null;
      ctrlEnd = c0 + (displayEnd - d0);
    }
    d = d1;
    ctrl = c1;
  }
  const tail = editor.querySelector('.content')?.textContent ?? '';
  if (d < tail.length) {
    const c0 = ctrl;
    if (displayStart >= d) ctrlStart = c0 + (displayStart - d);
    if (displayEnd >= d) ctrlEnd = c0 + (displayEnd - d);
  }
  if (ctrlStart == null || ctrlEnd == null) return null;
  return { start: ctrlStart, end: ctrlEnd };
}

function mapDisplayRangeToController(ctrl, editor, displayStart, displayEnd) {
  const serialized = readControllerString(ctrl, editor);
  if (!serialized || !controllerLooksSerialized(serialized)) {
    const heuristic = mapDisplayRangeHeuristic(editor, displayStart, displayEnd);
    return heuristic ?? { start: displayStart, end: displayEnd };
  }
  const segments = buildDisplayControllerSegments(editor, serialized);
  if (segments.length === 0) {
    return { start: displayStart, end: displayEnd };
  }

  let ctrlStart = null;
  let ctrlEnd = null;
  for (const seg of segments) {
    if (displayStart >= seg.d0 && displayStart < seg.d1) {
      if (seg.isField && displayStart > seg.d0) return null;
      ctrlStart = seg.c0 + (displayStart - seg.d0);
    }
    if (displayEnd > seg.d0 && displayEnd <= seg.d1) {
      if (seg.isField && displayEnd < seg.d1) return null;
      ctrlEnd = seg.c0 + (displayEnd - seg.d0);
    }
  }
  const last = segments[segments.length - 1];
  if (ctrlStart == null && last && displayStart >= last.d1) {
    ctrlStart = last.c1 + (displayStart - last.d1);
  }
  if (ctrlEnd == null && last && displayEnd >= last.d1) {
    ctrlEnd = last.c1 + (displayEnd - last.d1);
  }
  if (ctrlStart == null || ctrlEnd == null) return null;
  return { start: ctrlStart, end: ctrlEnd };
}

function spanIsFieldChip(span) {
  const cls = span.className;
  if (typeof cls === 'string') return cls.includes('field');
  if (cls && typeof cls.baseVal === 'string') return cls.baseVal.includes('field');
  return false;
}

// Use frozen getCurrentRange() start/caret (same coords as filtering). Reject only
// when the range is strictly inside a committed field chip (not partial @ tokens).
function resolveFuzzyControllerIndexes(editor, ctrl, pending) {
  if (!editor || !pending) return { indexes: null, source: null };

  const liveSel = getControllerSelectionRange(ctrl);
  if (liveSel && liveSel.end > liveSel.start) {
    return { indexes: liveSel, source: 'live-controller-selection' };
  }

  const displayStart = pending.tokenStart;
  const displayEnd = pendingDisplayEnd(pending);
  if (typeof displayStart !== 'number' || typeof displayEnd !== 'number') {
    return { indexes: null, source: null };
  }
  if (displayEnd < displayStart) {
    return { indexes: null, source: null };
  }

  const spans = contentSpans(editor);
  let displayPos = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const spanText = (span.textContent ?? '').replace(/\u200b/g, '');
    const d0 = displayPos;
    const d1 = displayPos + spanText.length;
    if (spanIsFieldChip(span) && displayStart > d0 && displayEnd < d1) {
      return { indexes: null, source: 'inside-field-chip' };
    }
    displayPos = d1;
  }

  const mapped = mapDisplayRangeToController(ctrl, editor, displayStart, displayEnd);
  if (!mapped) {
    return { indexes: null, source: 'map-failed' };
  }
  const serialized = readControllerString(ctrl, editor);
  let source = 'frozen-token-range';
  if (controllerLooksSerialized(serialized)) source = 'display-to-controller';
  else if (mapped.start !== displayStart || mapped.end !== displayEnd) {
    source = 'display-heuristic';
  }
  return { indexes: mapped, source };
}

function buildFuzzyOnSelectPayload(item, indexes) {
  const label = getLabel(item);
  const value =
    item && typeof item === 'object' && typeof item.value === 'string' ? item.value : label;
  const type =
    item && typeof item === 'object' && typeof item.type === 'string'
      ? item.type
      : typeof value === 'string' && value.startsWith('@')
        ? 'field'
        : 'function';
  return {
    value,
    type,
    indexes: { start: indexes.start, end: indexes.end },
  };
}

// ---------- overlay ----------
function buildOverlay(popper) {
  const list = popper.querySelector(LIST_SEL);
  if (!list) return null;
  const wrapper = list.parentElement;
  if (!wrapper) return null;
  const width = list.style.width || '348px';
  const height = list.style.height || '200px';
  wrapper.setAttribute(LIST_HOST_ATTR, 'true');
  list.setAttribute(HIDE_REACT_LIST_ATTR, 'true');
  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.style.width = width;
  overlay.style.height = height;
  wrapper.appendChild(overlay);
  return overlay;
}

function render(state) {
  const { overlay, editor } = state;
  if (!overlay) return;
  // React renders are immutable — the props.suggestions reference we cached
  // at attach time will go stale as soon as the user types. Re-read it on
  // every render via the fiber+key source we saved.
  const liveMaster = readArrayFrom(state.masterSource);
  if (liveMaster) state.masterList = liveMaster;
  const range = getCurrentRange(editor);
  state.currentRange = range;
  const query = range.query;
  state.filtered = fuzzyFilter(state.masterList, query);
  const listKey = filteredListKey(query, state.filtered);
  if (listKey !== state.filterListKey) {
    state.filterListKey = listKey;
    state.selectedIndex = 0;
  } else if (state.selectedIndex >= state.filtered.length) {
    state.selectedIndex = Math.max(0, state.filtered.length - 1);
  } else if (state.selectedIndex < 0 && state.filtered.length > 0) {
    state.selectedIndex = 0;
  }

  overlay.replaceChildren();
  if (state.filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = EMPTY_CLASS;
    empty.textContent = query ? `No fuzzy matches for "${query}"` : 'No options';
    overlay.appendChild(empty);
    scheduleCaptureRenderLog(state, range, query);
    return;
  }
  for (let i = 0; i < state.filtered.length; i++) {
    const item = state.filtered[i];
    const row = document.createElement('div');
    row.className = ROW_CLASS;
    if (!isFieldItem(item)) row.classList.add(FN_ROW_CLASS);
    if (i === state.selectedIndex) row.classList.add(SELECTED_CLASS);
    row.textContent = getLabel(item);
    const idx = i;
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      // Do not focus the editor here — it jumps the controller caret into the
      // first chip. pendingSelection is frozen from the last overlay render.
      state.pendingSelection = capturePendingSelection(state);
    });
    row.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      selectItem(state, idx);
    });
    overlay.appendChild(row);
  }
  scheduleCaptureRenderLog(state, range, query);
}

function selectItem(state, i) {
  const item = state.filtered[i];
  if (!item) return;

  const pending = state.pendingSelection ?? refreshPendingSelection(state);
  const activeQuery = (pending?.filterQuery ?? '').trim();
  const tokenEnd = pendingDisplayEnd(pending);
  if (
    !activeQuery &&
    typeof pending?.tokenStart === 'number' &&
    tokenEnd === pending.tokenStart
  ) {
    logAt(LOG.select, 'select skipped — no active token', { label: getLabel(item) });
    return;
  }
  state.pendingSelection = null;
  const beforeText = snapshotEditorText(state.editor);
  const label = getLabel(item);
  const ctrl = findController(state.editor);

  const fallbackOnSelection = () => {
    if (ctrl && typeof state.onSelect === 'function') {
      selectItemViaOnSelection(state, item, pending, ctrl, beforeText, label);
    } else {
      logAt(LOG.select, 'cannot select', { label });
    }
  };

  // Fields: try typing `@Table Record…` (Tulip auto-parses); else Tulip's onSelection.
  if (isFieldItem(item)) {
    typeFieldReference(state, item, pending);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (fieldReferenceTypedOk(state.editor, item, pending)) {
          logSelectAfter(state, label, beforeText, 'type-field');
          return;
        }
        logAt(LOG.select, 'type-field failed — onSelection', { label });
        fallbackOnSelection();
      });
    });
    return;
  }

  // Functions/operators: same as a native list pick when possible.
  if (invokeNativeSelect(state, item)) {
    logAt(LOG.select, 'select via native row onClick', { label });
    logSelectAfter(state, label, beforeText, 'native');
    return;
  }
  fallbackOnSelection();
}

function moveSelection(state, delta) {
  if (state.filtered.length === 0) return;
  const next = (state.selectedIndex + delta + state.filtered.length) % state.filtered.length;
  state.selectedIndex = next;
  const rows = state.overlay.querySelectorAll('.' + ROW_CLASS);
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle(SELECTED_CLASS, i === next);
  }
  rows[next]?.scrollIntoView({ block: 'nearest' });
}

// Keydown is handled by a single window-level capture-phase listener
// installed once at module load (see `installGlobalKeyHandler`). The reason
// it can't be per-editor is that Tulip already has its own keydown handler
// registered on the editor (custom expression-editor input — not a real
// contenteditable). Element-level listeners fire in registration order;
// ours would be added AFTER Tulip's when the popper opens, so Tulip would
// run first and (we suspect) call `stopImmediatePropagation`, preventing
// our handler from ever seeing the key. Capture-phase on window fires
// strictly before any element listener regardless of registration order,
// so we beat Tulip every time — and `stopImmediatePropagation` keeps
// Tulip from also navigating its (now-hidden) native list.
function findActiveStateForTarget(target) {
  if (!(target instanceof Element)) return null;
  for (const popper of document.querySelectorAll(POPPER_SEL)) {
    const s = popperState.get(popper);
    if (!s) continue;
    if (s.editor === target || s.editor.contains(target)) return s;
  }
  return null;
}

function findSaveButton(editor) {
  const popper = editor.closest(POPPER_SEL);
  const scope =
    popper?.closest('[role="dialog"]') ||
    popper?.parentElement ||
    document;
  return scope.querySelector(SAVE_BTN_SEL);
}

function ensureSaveButtonHint(editor) {
  const btn = findSaveButton(editor);
  if (!btn || btn.hasAttribute(SAVE_HINT_ATTR)) return;
  const base = (btn.getAttribute('aria-label') || btn.textContent || 'Save').trim();
  const hint = `${base} (Ctrl+Enter)`;
  btn.setAttribute('aria-label', hint);
  btn.setAttribute('title', hint);
  btn.setAttribute(SAVE_HINT_ATTR, 'true');
}

function isSaveShortcut(e) {
  return e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
}

function onGlobalKeyDown(e) {
  if (!enabled) return;
  const state = findActiveStateForTarget(e.target);
  if (state && isSaveShortcut(e)) {
    const saveBtn = findSaveButton(state.editor);
    if (saveBtn && !saveBtn.disabled) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      saveBtn.click();
    }
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
  if (!state) return;
  if (e.key === 'Enter') {
    const range = getCurrentRange(state.editor);
    state.currentRange = range;
    if (!range.query.trim()) return;
    if (state.filtered.length === 0) return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
  if (e.key === 'ArrowDown') moveSelection(state, 1);
  else if (e.key === 'ArrowUp') moveSelection(state, -1);
  else {
    selectItem(state, state.selectedIndex);
  }
}

let globalKeyHandlerInstalled = false;
function installGlobalKeyHandler() {
  if (globalKeyHandlerInstalled) return;
  globalKeyHandlerInstalled = true;
  window.addEventListener('keydown', onGlobalKeyDown, true);
}

// ---------- attach/detach ----------
// Tulip often keeps the same `[data-testid="popper"]` across close/reopen while
// React remounts the list (and our overlay). Treat attachment as live only when
// the cached list/editor nodes are still the ones inside the popper.
function attachmentLive(popper, state) {
  if (!state) return false;
  const editor = popper.querySelector(EDITOR_SEL);
  const list = popper.querySelector(LIST_SEL);
  return !!(
    editor &&
    list &&
    state.editor === editor &&
    state.list === list &&
    state.overlay?.isConnected &&
    popper.contains(state.overlay)
  );
}

function dropStalePopperAttachment(popper) {
  if (!popperState.has(popper)) return false;
  const state = popperState.get(popper);
  if (attachmentLive(popper, state)) return false;
  detachFromPopper(popper);
  return true;
}

function attachToPopper(popper) {
  if (popperState.has(popper)) {
    if (attachmentLive(popper, popperState.get(popper))) return;
    detachFromPopper(popper);
  }
  const editor = popper.querySelector(EDITOR_SEL);
  if (!editor) return;
  const list = popper.querySelector(LIST_SEL);
  if (!list) return;

  log('candidate popper, looking up React fiber…', domDescriptor(popper));

  const found = fiberOfNearestHost(list);
  if (!found) {
    log(
      'no fiber on list or any of its 6 nearest ancestors.',
      '\nlist expando keys:', reactKeysOn(list),
      '\nlist.parent keys:', reactKeysOn(list.parentElement),
      '\npopper keys:', reactKeysOn(popper),
      '\nallKeysOnList:', (() => {
        try { return Object.getOwnPropertyNames(list); } catch (_) { return '<err>'; }
      })(),
    );
    return;
  }
  if (found.host !== list) {
    log('fiber found on ancestor, not list itself:', found.host);
  }
  const listFiber = found.fiber;

  const { master } = findLists(listFiber);
  if (!master) {
    log(
      'no master list found on fiber chain. Dumping summary:',
      summarizeFiberChain(list),
    );
    return;
  }
  log(
    'master list:',
    `${master.key.kind}.${master.key.name}`,
    'len',
    master.list.length,
    'sample[0]',
    master.list[0],
  );

  const select = findSelectHandler(listFiber);
  if (!select) {
    log(
      'no select handler found on fiber chain. Dumping summary:',
      summarizeFiberChain(list),
    );
    return;
  }

  const overlay = buildOverlay(popper);
  if (!overlay) return;

  const state = {
    popper,
    editor,
    list,
    overlay,
    masterList: master.list,
    masterSource: master,
    onSelect: select,
    selectedIndex: 0,
    filtered: [],
  };

  const editorObs = new MutationObserver(() => render(state));
  editorObs.observe(editor, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  state.editorObs = editorObs;

  popperState.set(popper, state);
  ensureSaveButtonHint(editor);
  render(state);
  log('attached');
}

function detachFromPopper(popper) {
  const state = popperState.get(popper);
  if (!state) return;
  state.editorObs?.disconnect();
  state.overlay?.remove();
  state.list?.removeAttribute(HIDE_REACT_LIST_ATTR);
  state.list?.parentElement?.removeAttribute(LIST_HOST_ATTR);
  popperState.delete(popper);
}

// Anchor on the (singleton) virtualized list and walk up to its popper. There
// are dozens of `[data-testid="popper"]` elements on a Tulip page (tooltips,
// menus, every floating thing); we'd just rather not enumerate them all and
// generate log spam. `closest()` is O(depth) — far cheaper than 60× querySelector.
function scanAll() {
  const lists = document.querySelectorAll(LIST_SEL);
  if (lists.length === 0) return;
  for (const list of lists) {
    const popper = list.closest(POPPER_SEL);
    if (!popper) continue;
    if (!popper.querySelector(EDITOR_SEL)) continue;
    if (enabled) attachToPopper(popper);
    if (observing) attachObservePopper(popper);
  }
}

function summarizeFiberChain(node) {
  const f = fiberOf(node);
  if (!f) return { error: 'no fiber' };
  const rows = [];
  let i = 0;
  for (const fib of walkUp(f)) {
    const typeName =
      fib.type?.displayName ||
      fib.type?.name ||
      (typeof fib.type === 'string' ? fib.type : String(fib.type));
    const arrays = {};
    const fns = [];
    const p = fib.memoizedProps;
    if (p && typeof p === 'object') {
      for (const k of Object.keys(p)) {
        const v = p[k];
        if (Array.isArray(v)) {
          let sample;
          try { sample = JSON.stringify(v[0]); } catch (_) { sample = '(non-ser)'; }
          arrays[k] = `len=${v.length} sample=${(sample || '').slice(0, 200)}`;
        } else if (typeof v === 'function') {
          fns.push(k);
        }
      }
    }
    rows.push({ depth: i++, type: typeName, propArrays: arrays, propFns: fns });
  }
  return rows;
}

// Coalesce scan requests across a single animation frame so that bursts of
// react-popper style updates don't trigger 60 redundant scans.
function requestScan() {
  if (pendingScan) return;
  pendingScan = true;
  requestAnimationFrame(() => {
    pendingScan = false;
    if (enabled || observing) scanAll();
  });
}

function onMutation(mutations) {
  for (const m of mutations) {
    if (m.type === 'attributes' && m.target instanceof Element) {
      // Style/class flips when a hidden popper is shown again often do not add
      // nodes — still re-check attachment so close/reopen can recover.
      const popper = m.target.matches?.(POPPER_SEL)
        ? m.target
        : m.target.closest?.(POPPER_SEL);
      if (popper) {
        if (popperState.has(popper) && dropStalePopperAttachment(popper)) {
          requestScan();
        } else if (!popperState.has(popper)) {
          requestScan();
        }
      }
      continue;
    }
    for (const node of m.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (
        node.matches?.(LIST_SEL) ||
        node.querySelector?.(LIST_SEL) ||
        node.matches?.(POPPER_SEL) ||
        node.querySelector?.(POPPER_SEL)
      ) {
        requestScan();
        break;
      }
    }
    for (const node of m.removedNodes) {
      if (!(node instanceof Element)) continue;
      if (popperState.has(node)) {
        detachFromPopper(node);
        continue;
      }
      const popper = node.closest?.(POPPER_SEL);
      if (popper && popperState.has(popper) && dropStalePopperAttachment(popper)) {
        requestScan();
      }
      if (observePoppers.has(node)) detachObservePopper(node);
      else {
        const obsPopper = node.closest?.(POPPER_SEL);
        if (obsPopper && observePoppers.has(obsPopper)) {
          const s = observePoppers.get(obsPopper);
          if (node === s.list || node === s.editor) detachObservePopper(obsPopper);
        }
      }
    }
  }
}

function startObserver() {
  if (docObserver) return;
  docObserver = new MutationObserver(onMutation);
  docObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'data-testid'],
  });
  log('observer started');
}

function stopObserver() {
  docObserver?.disconnect();
  docObserver = null;
}

function detachAll() {
  for (const popper of document.querySelectorAll(POPPER_SEL)) {
    detachFromPopper(popper);
  }
}

// ---------- observe mode ----------
// Independent, console-toggleable shadow of Tulip's native popup. Does NOT
// touch the UI — no overlay, no list hide. Just tails every render and
// every row click so we can see exactly what Tulip is doing:
//
//   __tulbeltFuzzy.capture()     // start (auto baseline vs enhanced from fuzzy toggle)
//   __tulbeltFuzzy.copyLog()       // export; tags phase + archives lastBaseline/Enhanced
//   __tulbeltFuzzy.capture(false)  // stop
//
// `observe(true)` — low-level shadow logger without capture session tagging.
let observing = false;
const observePoppers = new WeakMap();

function snapshotEditorText(editor) {
  const content = editor?.querySelector('.content');
  return content?.textContent ?? '';
}

function snapshotContentSpans(editor) {
  return contentSpans(editor).map((span) => ({
    dataIndex: span.getAttribute('data-index'),
    len: (span.textContent ?? '').replace(/\u200b/g, '').length,
    text: (span.textContent ?? '').replace(/\u200b/g, '').slice(0, 60),
    class: span.className || undefined,
  }));
}

function captureControllerContext(editor) {
  const ctrl = editor ? findController(editor) : null;
  const range = editor ? getCurrentRange(editor) : null;
  return {
    domRange: range
      ? {
          query: range.query,
          start: range.start,
          end: range.end,
          caret: range.caret,
        }
      : null,
    caretOffsetIn: editor ? caretOffsetIn(editor) : null,
    controllerCursor: ctrl ? readControllerCursor(ctrl) : null,
    controllerSelection: ctrl ? getControllerSelectionRange(ctrl) : null,
    contentSpans: editor ? snapshotContentSpans(editor) : null,
  };
}

function sanitizeSelectionPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = {};
  for (const k of ['value', 'type', 'display', 'displayName', 'label', 'indexes']) {
    if (payload[k] !== undefined) out[k] = sanitizeForExport(payload[k]);
  }
  if (Object.keys(out).length === 0) return sanitizeForExport(payload);
  return out;
}

function masterIndexInList(list, item) {
  if (!Array.isArray(list) || !item) return -1;
  const targetValue = typeof item === 'object' ? item.value : undefined;
  const targetLabel = getLabel(item);
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!row) continue;
    if (targetValue && row.value === targetValue) return i;
    if (labelsMatch(getLabel(row), targetLabel)) return i;
  }
  return -1;
}

function wrapObserveSelectHandler(state) {
  if (state.selectWrap) return;
  const found = fiberOfNearestHost(state.list);
  if (!found) return;
  const handler = findSelectHandlerFiber(found.fiber);
  if (!handler || handler.fn.__tulbeltObserveWrap) return;
  const { fiber, key, fn } = handler;
  const editor = state.editor;
  const wrapped = function (...args) {
    logAt(
      LOG.observe,
      capturePhase ? 'capture:onSelection' : '[baseline:onSelection]',
      {
        argCount: args.length,
        payload: args.length === 1 ? sanitizeSelectionPayload(args[0]) : sanitizeForExport(args),
        controller: captureControllerContext(editor),
      },
    );
    return fn.apply(this, args);
  };
  wrapped.__tulbeltObserveWrap = true;
  try {
    fiber.memoizedProps[key] = wrapped;
    state.selectWrap = { fiber, key, orig: fn };
  } catch (_) {}
}

function unwrapObserveSelectHandler(state) {
  const w = state.selectWrap;
  if (!w) return;
  try {
    if (w.fiber.memoizedProps[w.key] === w.orig || w.fiber.memoizedProps[w.key]?.__tulbeltObserveWrap) {
      w.fiber.memoizedProps[w.key] = w.orig;
    }
  } catch (_) {}
  state.selectWrap = null;
}

// Minimal diff: where text changed, what was removed/inserted.
function diffAround(before, after) {
  if (before === after) return { unchanged: true };
  let start = 0;
  const minLen = Math.min(before.length, after.length);
  while (start < minLen && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  return {
    start,
    removed: before.slice(start, endB),
    inserted: after.slice(start, endA),
  };
}

/** Same shape as capturePendingSelection — usable without fuzzy attach state. */
function captureEditorPending(editor) {
  const range = editor ? getCurrentRange(editor) : null;
  const ctrl = editor ? findController(editor) : null;
  return {
    filterQuery: range?.query ?? '',
    tokenStart: typeof range?.start === 'number' ? range.start : null,
    tokenEnd: typeof range?.end === 'number' ? range.end : null,
    tokenCaret: typeof range?.caret === 'number' ? range.caret : null,
    selection: ctrl ? getControllerSelectionRange(ctrl) : null,
    controllerCursor: ctrl ? readControllerCursor(ctrl) : null,
  };
}

function snapshotListDom(list) {
  if (!list) return null;
  return {
    nativeRowCount: list.querySelectorAll(NATIVE_ROW_SEL).length,
    listHidden: list.getAttribute(HIDE_REACT_LIST_ATTR) === 'true',
    connected: list.isConnected,
  };
}

/** Indexes Tulip would receive from onSelection for the current token (fuzzy path). */
function captureIndexPreview(editor, pending) {
  const ctrl = editor ? findController(editor) : null;
  if (!ctrl || !pending) return null;
  const mapped = resolveFuzzyControllerIndexes(editor, ctrl, pending);
  if (mapped.indexes) {
    return { indexes: mapped.indexes, source: mapped.source };
  }
  return mapped.source ? { source: mapped.source } : null;
}

// Shared capture:edit / capture:attach payload — mirrors plugin token + index logic.
function buildObserveCapturePayload(state, range) {
  const master = readArrayFrom(state.masterSource);
  const pending = captureEditorPending(state.editor);
  return {
    text: range.text,
    query: range.query,
    range: { start: range.start, end: range.end, caret: range.caret },
    pending,
    controller: captureControllerContext(state.editor),
    listDom: snapshotListDom(state.list),
    master: master ? { len: master.length, sample0: master[0] } : null,
  };
}

function logObserveState(state, reason) {
  const range = getCurrentRange(state.editor);
  const observeTag = capturePhase ? `capture:${reason}` : `observe:${reason}`;
  logAt(LOG.observe, `[${observeTag}]`, buildObserveCapturePayload(state, range));
}

function scheduleCaptureRenderLog(state, range, query) {
  if (capturePhase !== 'enhanced') return;
  if (state._renderLogScheduled) return;
  state._renderLogScheduled = true;
  requestAnimationFrame(() => {
    state._renderLogScheduled = false;
    const pending = capturePendingSelection(state);
    logAt(LOG.select, 'capture:render', {
      query,
      filteredLen: state.filtered?.length ?? 0,
      selectedIndex: state.selectedIndex,
      selectedLabel:
        state.filtered?.[state.selectedIndex] != null
          ? getLabel(state.filtered[state.selectedIndex])
          : null,
      pending,
      indexPreview: captureIndexPreview(state.editor, pending),
      range: { start: range.start, end: range.end, caret: range.caret },
    });
  });
}

function observeAttachmentLive(popper, state) {
  if (!state) return false;
  const editor = popper.querySelector(EDITOR_SEL);
  const list = popper.querySelector(LIST_SEL);
  return !!(editor && list && state.editor === editor && state.list === list);
}

function attachObservePopper(popper) {
  if (observePoppers.has(popper)) {
    const existing = observePoppers.get(popper);
    if (observeAttachmentLive(popper, existing)) {
      wrapObserveSelectHandler(existing);
      return;
    }
    detachObservePopper(popper);
  }
  const editor = popper.querySelector(EDITOR_SEL);
  if (!editor) return;
  const list = popper.querySelector(LIST_SEL);
  if (!list) return;
  const found = fiberOfNearestHost(list);
  if (!found) {
    logAt(LOG.observe, '[observe] no fiber on list — cannot attach', domDescriptor(popper));
    return;
  }
  const lists = findLists(found.fiber);
  if (!lists.master) {
    logAt(LOG.observe, '[observe] no master list — cannot attach', domDescriptor(popper));
    return;
  }
  logAt(
    LOG.observe,
    '[observe] attached. master:',
    `${lists.master.key.kind}.${lists.master.key.name}`,
    'len',
    lists.master.list.length,
  );

  const state = {
    popper,
    editor,
    list,
    masterSource: lists.master,
  };

  // Coalesce bursts of mutations (Tulip can fire 3-5 per keystroke between
  // updating `.content`, the cursor span, error chip, etc.) into a single
  // log per animation frame. Otherwise the observe console is unreadable.
  const obs = new MutationObserver(() => {
    if (state._logScheduled) return;
    state._logScheduled = true;
    requestAnimationFrame(() => {
      state._logScheduled = false;
      logObserveState(state, 'edit');
    });
  });
  obs.observe(editor, { childList: true, subtree: true, characterData: true });
  state.obs = obs;

  wrapObserveSelectHandler(state);

  // Capture-phase click listener — fires before React's synthetic handler
  // so we can snapshot the editor pre-insert, and on the next rAF we
  // snapshot post-insert to log the diff Tulip just made.
  const onClick = (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const rowEl = target.closest(NATIVE_ROW_SEL);
    if (!rowEl) return;
    const before = snapshotEditorText(editor);
    const rowText = (rowEl.textContent ?? '').trim();
    const found = findRowItemNear(target);
    let item = found?.item ?? null;
    if (!item) item = findItemByRowLabel(state, rowText);
    const master = readArrayFrom(state.masterSource);
    const masterIdx = masterIndexInList(master, item ?? { value: rowText });
    const clickTag = capturePhase ? 'capture:click' : '[baseline:click]';
    logAt(LOG.observe, clickTag, {
      rowText: rowText.slice(0, 120),
      item: sanitizeSelectionPayload(item),
      itemPropKey: found?.key ?? null,
      masterIdx: masterIdx >= 0 ? masterIdx : null,
      editorBefore: before,
      controller: captureControllerContext(editor),
    });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const after = snapshotEditorText(editor);
        const afterTag = capturePhase ? 'capture:click→after' : '[baseline:click→after]';
        logAt(LOG.observe, afterTag, {
          editorAfter: after,
          delta: diffAround(before, after),
          controller: captureControllerContext(editor),
        });
      });
    });
  };
  list.addEventListener('click', onClick, true);
  state.onClick = onClick;

  // Enter/Tab/arrow picks on the native list often skip click — mirror capture:click→after.
  const onEditorKeyDown = (e) => {
    if (e.key !== 'Enter' && e.key !== 'Tab' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
      return;
    }
    const keyTag = capturePhase ? 'capture:keydown' : '[baseline:keydown]';
    logAt(LOG.observe, keyTag, {
      key: e.key,
      ...buildObserveCapturePayload(state, getCurrentRange(editor)),
    });
    if (e.key !== 'Enter' && e.key !== 'Tab') return;
    const before = snapshotEditorText(editor);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const afterTag = capturePhase ? 'capture:keydown→after' : '[baseline:keydown→after]';
        logAt(LOG.observe, afterTag, {
          key: e.key,
          editorAfter: snapshotEditorText(editor),
          delta: diffAround(before, snapshotEditorText(editor)),
          controller: captureControllerContext(editor),
        });
      });
    });
  };
  editor.addEventListener('keydown', onEditorKeyDown, true);
  state.onEditorKeyDown = onEditorKeyDown;

  observePoppers.set(popper, state);
  logObserveState(state, 'attach');
}

function detachObservePopper(popper) {
  const s = observePoppers.get(popper);
  if (!s) return;
  unwrapObserveSelectHandler(s);
  s.obs?.disconnect();
  if (s.onClick && s.list) {
    s.list.removeEventListener('click', s.onClick, true);
  }
  if (s.onEditorKeyDown && s.editor) {
    s.editor.removeEventListener('keydown', s.onEditorKeyDown, true);
  }
  observePoppers.delete(popper);
}

function detachAllObserve() {
  for (const popper of document.querySelectorAll(POPPER_SEL)) {
    detachObservePopper(popper);
  }
}

function applyObserving(next) {
  const value = !!next;
  if (value === observing) return;
  observing = value;
  if (!observing && capturePhase) {
    capturePhase = null;
    setLogLevel(LOG.off);
  }
  syncSessionRecording();
  if (observing) {
    logAt(LOG.observe, 'observe: starting');
    startObserver();
    requestScan();
  } else {
    logAt(LOG.observe, 'observe: stopping');
    detachAllObserve();
    if (!enabled) stopObserver();
  }
}

function resolveCapturePhase(phase) {
  if (phase === 'baseline' || phase === 'enhanced') return phase;
  return enabled ? 'enhanced' : 'baseline';
}

function startCapture(phase) {
  capturePhase = phase;
  clearSessionLog();
  sessionRecording = true;
  if (!observing) applyObserving(true);
  if (phase === 'baseline') {
    setLogLevel(LOG.observe);
    if (enabled) {
      logAt(
        LOG.observe,
        '[capture] warning: fuzzy is ON — turn OFF in Tulbelt for a native baseline',
      );
    }
    logAt(
      LOG.observe,
      '[capture] baseline — use Tulip native list (not overlay), then copyLog()',
    );
    return 'capture:baseline active (fuzzy OFF recommended)';
  }
  setLogLevel(LOG.select);
  if (!enabled) {
    logAt(LOG.select, '[capture] warning: fuzzy is OFF — turn ON in Tulbelt for enhanced');
  }
  logAt(LOG.select, '[capture] enhanced — use overlay / Enter, then copyLog()');
  return 'capture:enhanced active (fuzzy ON required)';
}

function stopCapture() {
  const was = capturePhase;
  capturePhase = null;
  applyObserving(false);
  setLogLevel(LOG.off);
  return was ? `capture:${was} stopped` : 'capture stopped (was inactive)';
}

/** Unified A/B capture — same commands for native vs overlay. */
function capture(phase) {
  if (phase === false || phase === 'stop' || phase === 'off') return stopCapture();
  if (phase === undefined && capturePhase) return stopCapture();
  const next = resolveCapturePhase(phase);
  if (capturePhase === next) return stopCapture();
  if (capturePhase) stopCapture();
  return startCapture(next);
}

function exportComparison() {
  return sanitizeForExport({
    exportedAt: new Date().toISOString(),
    baseline: debugApi.lastBaselineExport,
    enhanced: debugApi.lastEnhancedExport,
  });
}

function copyComparison() {
  const payload = exportComparison();
  let text;
  try {
    text = safeJsonStringify(payload);
  } catch (e) {
    text = JSON.stringify({ error: 'copyComparison failed', message: String(e?.message || e) });
  }
  debugApi.lastComparison = payload;
  debugApi.lastComparisonJson = text;
  if (typeof copy === 'function') {
    try {
      copy(text);
      console.log('[tulbelt:fuzzy:main] copied baseline+enhanced comparison to clipboard');
      return payload;
    } catch (_) {}
  }
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => {
      console.log('[tulbelt:fuzzy:main] copied baseline+enhanced comparison to clipboard');
      return payload;
    });
  }
  console.log('[tulbelt:fuzzy:main] copy(__tulbeltFuzzy.lastComparisonJson)');
  return payload;
}

function applyEnabled(next) {
  if (next === enabled) return;
  enabled = next;
  if (enabled) {
    log('enabling');
    ensureStyles();
    installGlobalKeyHandler();
    startObserver();
    requestScan();
  } else {
    log('disabling');
    detachAll();
    removeStyles();
    // Keep the doc observer running if the user is still observing.
    if (!observing) stopObserver();
  }
}

function readEnabledAttr() {
  return document.documentElement.getAttribute(ATTR) === 'true';
}

// Watch <html data-tulbelt-fuzzy-enabled> for changes (set by the isolated
// content-script half whose chrome.storage listener fires on toggle).
const attrObserver = new MutationObserver(() => applyEnabled(readEnabledAttr()));
attrObserver.observe(document.documentElement, {
  attributes: true,
  attributeFilter: [ATTR],
});

function findAttachedFuzzyState() {
  for (const popper of document.querySelectorAll(POPPER_SEL)) {
    const s = popperState.get(popper);
    if (s) return s;
  }
  return null;
}

// Structured snapshot for agents — paste console output or assign to a var.
function buildReport() {
  const editor = document.querySelector(EDITOR_SEL);
  const domRange = editor ? getCurrentRange(editor) : null;
  const attached = findAttachedFuzzyState();
  const ctrl = editor ? findController(editor) : null;
  return {
    enabled,
    debug: logLevelName(),
    observing,
    editorText: editor ? snapshotEditorText(editor) : null,
    filterQuery: domRange?.query ?? null,
    tokenRange: domRange
      ? { start: domRange.start, end: domRange.end, caret: domRange.caret }
      : null,
    controllerSelection: ctrl ? getControllerSelectionRange(ctrl) : null,
    attached: attached
      ? {
          filteredLen: attached.filtered?.length ?? 0,
          selectedIndex: attached.selectedIndex,
          masterLen: attached.masterList?.length ?? 0,
        }
      : null,
  };
}

// Devtools API — page main world (`window.__tulbeltFuzzy`).
const debugApi = {
  enabled: () => enabled,
  observing: () => observing,
  /** Full session: { entries, state, … } — assign or JSON.stringify for agents */
  exportLog,
  /** JSON to clipboard when possible; same object on .lastExport */
  copyLog,
  clearLog: clearSessionLog,
  /** Force recording on/off (default on when debug≥select or observe) */
  record: (on) => {
    if (on === undefined) return sessionRecording;
    sessionRecording = !!on;
    if (sessionRecording) clearSessionLog();
    return sessionRecording;
  },
  lastExport: null,
  /** Pre-stringified session log — safe to copy() directly */
  lastExportJson: null,
  debug: (level) => setLogLevel(level),
  // Alias: __tulbeltFuzzy.debug('select') — logs each insert + before/after diff
  traceSelect: (next) => {
    if (next === undefined) return setLogLevel(logLevel >= LOG.select ? LOG.off : LOG.select);
    return setLogLevel(next ? LOG.select : LOG.off);
  },
  setEnabled: (next) => applyEnabled(!!next),
  observe: (next) => applyObserving(next === undefined ? !observing : !!next),
  /**
   * Unified capture for native (baseline) vs overlay (enhanced).
   * capture() / capture('baseline'|'enhanced') / capture(false)
   */
  capture,
  captureActive: () => !!capturePhase,
  capturePhase: () => capturePhase,
  exportComparison,
  copyComparison,
  lastBaselineExport: null,
  lastBaselineJson: null,
  lastEnhancedExport: null,
  lastEnhancedJson: null,
  lastComparison: null,
  lastComparisonJson: null,
  /** @deprecated use capture('baseline') or capture() with fuzzy off */
  baseline: (on) => capture(on === false ? false : 'baseline'),
  /** @deprecated use capture('enhanced') or capture() with fuzzy on */
  enhanced: (on) => capture(on === false ? false : 'enhanced'),
  baselineActive: () => capturePhase === 'baseline',
  enhancedActive: () => capturePhase === 'enhanced',
  report: () => buildReport(),
  snapshot: () => {
    const r = buildReport();
    console.log('[tulbelt:fuzzy:main] report', r);
    return r;
  },
  scan: () => scanAll(),
  popper: () => document.querySelector(POPPER_SEL),
  list: () => document.querySelector(LIST_SEL),
  editor: () => document.querySelector(EDITOR_SEL),
  fiber: (node) => fiberOf(node ?? document.querySelector(LIST_SEL)),
  dump: (node) => summarizeFiberChain(node ?? document.querySelector(LIST_SEL)),
  findLists: (node) => {
    const f = fiberOf(node ?? document.querySelector(LIST_SEL));
    return f ? findLists(f) : null;
  },
  dumpArrays: (node) => {
    const f = fiberOf(node ?? document.querySelector(LIST_SEL));
    if (!f) return null;
    const result = findLists(f);
    const summarize = (entry) => entry && {
      len: entry.list.length,
      key: entry.key,
      fiberType:
        entry.fiber.type?.displayName ||
        entry.fiber.type?.name ||
        String(entry.fiber.type).slice(0, 30),
      sample: entry.list[0],
    };
    return {
      master: summarize(result.master),
      all: result.all.map(summarize),
    };
  },
  listDom: () => snapshotListDom(document.querySelector(LIST_SEL)),
  findSelect: (node) => {
    const f = fiberOf(node ?? document.querySelector(LIST_SEL));
    return f ? findSelectHandler(f, true) : null;
  },
  range: () => {
    const ed = document.querySelector(EDITOR_SEL);
    return ed ? getCurrentRange(ed) : null;
  },
  selection: () => {
    const ed = document.querySelector(EDITOR_SEL);
    const ctrl = ed ? findController(ed) : null;
    return ctrl ? getControllerSelectionRange(ctrl) : null;
  },
  controllerMethods: () => {
    const ed = document.querySelector(EDITOR_SEL);
    const ctrl = ed ? findController(ed) : null;
    if (!ctrl) return [];
    const names = new Set();
    for (let o = ctrl; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) {
        if (typeof o[k] === 'function') names.add(k);
      }
    }
    return [...names].sort();
  },
  state: () => {
    const s = findAttachedFuzzyState();
    if (!s) return null;
    const ctrl = findController(s.editor);
    return {
      masterLen: s.masterList?.length ?? 0,
      masterSrc: s.masterSource?.key,
      filterQuery: s.currentRange?.query,
      controllerSelection: ctrl ? getControllerSelectionRange(ctrl) : null,
      filteredLen: s.filtered?.length ?? 0,
      selectedIndex: s.selectedIndex,
    };
  },
};

try { window.__tulbeltFuzzy = debugApi; } catch (_) {}

applyEnabled(readEnabledAttr());
})();
