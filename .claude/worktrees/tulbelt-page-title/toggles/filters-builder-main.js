// MAIN-world half of filters-builder. Probing TextInputWithPills' fiber
// showed the field's React state is a single plain string — pills are render
// sugar for `$Name$` runs — owned by the nearest ancestor component with
// props { value: string, onChange: fn(string) }. The isolated half dispatches
// `tulbelt:filters-write` on the wrapper element with the new canonical
// string as the detail (a JSON string — object details don't reliably cross
// the world boundary); this half finds that ancestor's onChange, calls it,
// and reports back via `tulbelt:filters-write-result` on the same element.
//
// Passive otherwise: it only reacts to events from the isolated half (which
// is gated by the toggle) and never touches the DOM itself, so there is
// nothing to revert on disable.

(() => {
  const WRITE_EVENT = "tulbelt:filters-write";
  const RESULT_EVENT = "tulbelt:filters-write-result";

  // React's fiber expando key varies by version; getOwnPropertyNames also
  // catches non-enumerable expandos. (Same approach as
  // expression-editor-fuzzy-main.js.)
  const FIBER_PREFIXES = ["__reactFiber$", "__reactInternalInstance$", "__reactContainer$"];
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
        if (k.startsWith(p)) {
          const v = node[k];
          if (v) return v;
        }
      }
    }
    return null;
  }

  function startFiber(wrapper) {
    return (
      fiberOf(wrapper) || fiberOf(wrapper.querySelector("input")) || fiberOf(wrapper.parentElement)
    );
  }

  function nameOf(fiber) {
    const t = fiber.type;
    if (typeof t === "string") return t;
    return t?.displayName || t?.name || "?";
  }

  // Climb from the wrapper to the nearest component owning the field state.
  // Looked up fresh on every write — React may have remounted since the last.
  function findOnChange(wrapper) {
    let f = startFiber(wrapper);
    let i = 0;
    while (f && i < 18) {
      const props = f.memoizedProps;
      if (
        props &&
        typeof props === "object" &&
        typeof props.onChange === "function" &&
        typeof props.value === "string"
      ) {
        return { fn: props.onChange, name: nameOf(f) };
      }
      f = f.return;
      i++;
    }
    return null;
  }

  document.addEventListener(
    WRITE_EVENT,
    (e) => {
      const wrapper = e.target instanceof Element ? e.target : null;
      const json = typeof e.detail === "string" ? e.detail : null;
      let result;
      if (!wrapper || json === null) {
        result = { ok: false, error: "malformed write event" };
      } else {
        const handler = findOnChange(wrapper);
        if (!handler) {
          result = { ok: false, error: "no React {value, onChange} ancestor found" };
        } else {
          try {
            handler.fn(json);
            result = { ok: true, component: handler.name };
          } catch (err) {
            result = { ok: false, error: String(err) };
          }
        }
      }
      (wrapper || document).dispatchEvent(
        new CustomEvent(RESULT_EVENT, {
          bubbles: true,
          detail: JSON.stringify(result),
        }),
      );
    },
    true,
  );
})();
