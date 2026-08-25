// Main-world half of paste-trigger-anywhere. Lives in `world: "MAIN"` at
// document_start because everything it needs is the page's own: the clipboard
// payload Tulip writes, and the paste event Tulip listens for.
//
// How a trigger copy travels: Tulip serializes the trigger to JSON, base64s it
// into `<span data-tulip-clipboard="…"></span>` and writes that as the
// clipboard's text/html flavor. On paste it parses that span back out and
// branches on the trigger's own binding:
//
//     no stepId, no widgetId  -> app level      (target: Process)
//     stepId, no widgetId     -> current step   (target: Step)
//     widgetId                -> selected widget (target: Widget)
//
// …then POSTs it to the paste API, which CREATES THE TRIGGER SERVER-SIDE and
// returns its new id; the editor opens on that. There is no Save to confirm.
//
// So moving a trigger between surfaces means rewriting that binding before
// Tulip reads it. Three fields move together, and the exact shape matters —
// Tulip validates the payload against its own codec before any request:
//
//   * `event`        — type (and eventName/customWidgetId/args where the type
//                      carries them)
//   * `stepId` / `widgetId` — ABSENT, not null. A null fails the codec.
//   * `haltOnError`  — app- and step-class records carry `true`; widget-class
//                      records do not carry the key at all.
//
// Everything else — every id, the clauses, and the whole envelope
// (sourceCustomer, workspace, queryIds, variables, recordPlaceholders) — is
// passed through exactly as copied. The stale `event.id` is fine: it names the
// source's event slot and the server does not mind.
//
// Verified against a live instance: all nine cross-surface combinations
// returned 201, appeared in their destination lists, kept their actions, and
// survived a hard reload. See docs/paste-trigger-anywhere.md.

(() => {
  const ENABLED_ATTR = "data-tulbelt-pta-enabled";
  const BUTTON_ATTR = "data-tulbelt-pta-paste";
  const STEP_ATTR = "data-tulbelt-pta-step";
  const GROUP_MARK = "data-tulbelt-pta-group";
  const RESULT_EVENT = "tulbelt:pta-result";
  const CLIP_ATTR = "data-tulip-clipboard";

  const EVENT_CLASS = {
    "app-start": "app",
    "app-complete": "app",
    "app-cancel": "app",
    "step-open": "step",
    "step-closed": "step",
    interval: "step",
    "device-output": "step",
    "machine-output": "step",
    "button-press": "widget",
    "custom-widget-event": "widget",
    "input-change": "widget",
    "input-exit": "widget",
    "enter-press": "widget",
    "row-select": "widget",
    "signature-complete": "widget",
  };
  const NEEDS_ARGS = { interval: true, "device-output": true };

  function enabled() {
    return document.documentElement.getAttribute(ENABLED_ATTR) === "true";
  }

  // ── reading the destination out of the page ───────────────────────────────
  // A widget destination needs the target widget's id, and a custom widget
  // section needs its own event id — neither of which can be derived from the
  // heading, since two different custom widget types were seen sharing an
  // event id. Both live in React props above the section element, so they are
  // read fresh at click time and nothing is keyed to a widget type: a custom
  // widget nobody has built yet works the same way.
  const FIBER_PREFIXES = ["__reactFiber$", "__reactInternalInstance$", "__reactContainer$"];
  const MAX_CLIMB = 40;

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

  // Climbs from a trigger-list section, taking the first value it finds for
  // each field. `group.types[0]` is the section's own event: an underscore-form
  // event name for a built-in section (see the alias table below), or a custom
  // widget's 17-character event id. Single-event components name neither — they
  // report `types: null` and an empty label.
  function readSection(group) {
    const found = { widgetId: null, customWidgetId: null, sectionEvent: null };
    let fiber = fiberOf(group);
    let depth = 0;
    while (fiber && depth < MAX_CLIMB) {
      const props = fiber.memoizedProps;
      if (props && typeof props === "object") {
        if (!found.widgetId && typeof props.widgetId === "string") found.widgetId = props.widgetId;
        if (!found.customWidgetId && typeof props.customWidgetId === "string") {
          found.customWidgetId = props.customWidgetId;
        }
        if (props.group && window.__ptaDebug) {
          // The whole prop, not just types[0] — if a section turns out not to
          // name its event type, whatever else it carries is the next lead.
          try {
            debug("group prop @" + depth, JSON.stringify(props.group).slice(0, 600));
          } catch (_) {}
        }
        if (!found.sectionEvent && props.group && Array.isArray(props.group.types)) {
          const first = props.group.types[0];
          if (typeof first === "string") found.sectionEvent = first;
        }
      }
      fiber = fiber.return;
      depth++;
    }
    debug("section props", found);
    return found;
  }

  // Tulip names widget events TWICE, in two spellings that are not mechanically
  // related. A trigger list section says `input_enter`; the same event in a
  // clipboard payload is `enter-press`. Most pairs differ only by the separator
  // (`input_exit` / `input-exit`), but that one does not — so a blanket
  // underscore-to-hyphen swap would invent `input-enter`, which is not an event
  // at all. Irregular pairs are listed; regular ones are converted and then
  // CHECKED against the payload vocabulary, so a wrong guess can never be sent —
  // it just falls through to the label fallback below.
  const SECTION_TYPE_ALIASES = { input_enter: "enter-press" };

  function eventTypeFromSection(sectionEvent) {
    if (!sectionEvent) return null;
    if (EVENT_CLASS[sectionEvent] === "widget") return sectionEvent;
    const alias = SECTION_TYPE_ALIASES[sectionEvent];
    if (alias) return alias;
    const normalized = sectionEvent.replace(/_/g, "-");
    return EVENT_CLASS[normalized] === "widget" ? normalized : null;
  }

  // Built-in component sections, by the label Tulip puts on them. A secondary
  // route, for a section that doesn't name its event type at all: the built-in
  // event vocabulary is closed and these are Tulip's own labels for it, so this
  // is narrow and checkable rather than a general rule. (Custom widgets never
  // come through here — their event is an id that no label could supply, and a
  // section that can't produce one pastes nothing.)
  const WIDGET_HEADINGS = {
    "on enter press": "enter-press",
    "on input exit": "input-exit",
    "on input change": "input-change",
    "on value change": "input-change",
    "on row select": "row-select",
    "on row selected": "row-select",
    "on signature complete": "signature-complete",
    "on button press": "button-press",
  };

  function typeFromHeading(group) {
    const heading = group.querySelector('[class*="triggerHeaderLabel"]');
    if (!heading) return null;
    const text = String(heading.textContent || "")
      .replace(/\s+/g, " ")
      .replace(/\(\d+\)\s*$/, "")
      .trim()
      .toLowerCase();
    return WIDGET_HEADINGS[text] || null;
  }

  // Set window.__ptaDebug = true in the page console to see what a click
  // resolved and what it sent — the only way to tell a section that named its
  // own event from one that was guessed.
  function debug(label, data) {
    if (!window.__ptaDebug) return;
    try {
      console.log("[tulbelt:pta] " + label, data);
    } catch (_) {}
  }

  // What to paste as, for a section the isolated half could not name from its
  // heading — i.e. a widget or custom widget panel. Returns null when the page
  // doesn't tell us enough, so nothing is pasted on a guess.
  function resolveDestination(button) {
    const declared = button.getAttribute(BUTTON_ATTR);
    // App- and step-level sections are named by their heading and need nothing
    // from the page — except a device output, which has to be borrowed.
    if (declared && declared !== "auto") {
      return { type: declared, opts: { stepId: button.getAttribute(STEP_ATTR) || null } };
    }

    const group = button.closest("[" + GROUP_MARK + "]");
    if (!group) return null;
    const { widgetId, customWidgetId, sectionEvent } = readSection(group);
    if (!widgetId) return null;

    const stepId = currentStepId();

    if (customWidgetId) {
      // Tulip refuses a non-custom event on a custom widget, so without this
      // section's own event id there is nothing safe to send.
      if (!sectionEvent || !/^[A-Za-z0-9]{17}$/.test(sectionEvent)) return null;
      return {
        type: "custom-widget-event",
        opts: { widgetId, stepId, eventName: sectionEvent, customWidgetId },
      };
    }

    // A built-in component. The section's own event type is what tells "On
    // enter press" from "On input exit" on the same widget, so it has to be
    // named exactly — a generic widget event would be re-derived by Tulip into
    // whichever event that component treats as its default, landing the trigger
    // in the wrong section.
    let type = eventTypeFromSection(sectionEvent);
    if (!type) type = typeFromHeading(group);
    // Neither says which. A single-event component — a button, an interactive
    // table — names no type and carries no label, so this is the normal path
    // for those: any widget-class event will do, because Tulip re-derives the
    // one event that component actually fires.
    if (!type) type = "button-press";
    return { type, opts: { widgetId, stepId } };
  }

  function currentStepId() {
    try {
      return new URL(location.href).searchParams.get("step");
    } catch (_) {
      return null;
    }
  }

  // ── the clipboard flavor, encoded exactly as Tulip encodes it ─────────────
  function encode(payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    return "<span " + CLIP_ATTR + '="' + btoa(binary) + '"></span>';
  }

  function decode(html) {
    const el = new DOMParser()
      .parseFromString(String(html), "text/html")
      .querySelector("[" + CLIP_ATTR + "]");
    if (!el) return null;
    const b64 = el.getAttribute(CLIP_ATTR);
    if (!b64) return null;
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // ── remember what Tulip last copied ───────────────────────────────────────
  // Reading the clipboard needs a permission prompt; watching what Tulip hands
  // the clipboard API needs nothing, and it is the same bytes. The async read
  // stays as the fallback for a trigger copied in another tab.
  let lastCopied = null;

  const clipProto = window.Clipboard && window.Clipboard.prototype;
  const originalWrite = clipProto && clipProto.write;
  if (originalWrite) {
    clipProto.write = function (items, ...rest) {
      try {
        if (enabled()) {
          const item = (items || []).find((i) => i && i.types && i.types.includes("text/html"));
          if (item) {
            item
              .getType("text/html")
              .then((blob) => blob.text())
              .then((html) => {
                const payload = decode(html);
                if (payload && payload.trigger) lastCopied = payload;
              })
              .catch(() => {});
          }
        }
      } catch (_) {}
      return originalWrite.call(this, items, ...rest);
    };
    // Left installed for the life of the page: Tulip may hold a reference to
    // the wrapper, and unwrapping under it is riskier than a no-op. When the
    // toggle is off it captures nothing and changes nothing.
  }

  async function readClipboardPayload() {
    if (lastCopied) return lastCopied;
    if (!navigator.clipboard || !navigator.clipboard.read) return null;
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (!item.types.includes("text/html")) continue;
      const html = await (await item.getType("text/html")).text();
      const payload = decode(html);
      if (payload) return payload;
    }
    return null;
  }

  // ── the rewrite ───────────────────────────────────────────────────────────
  function rewrite(payload, type, opts) {
    const klass = EVENT_CLASS[type];
    if (!klass) throw new Error("unknown event type");

    const next = JSON.parse(JSON.stringify(payload));
    const trigger = next.trigger;
    const sourceEvent = trigger.event || {};

    const event = { id: sourceEvent.id, type };
    if (type === "custom-widget-event") {
      if (!opts.eventName || !opts.customWidgetId) throw new Error("missing widget event ids");
      event.eventName = opts.eventName;
      event.customWidgetId = opts.customWidgetId;
    }
    if (NEEDS_ARGS[type]) {
      // A trigger already of this type brings its own configuration; anything
      // else gets an unset one for the user to fill in in the editor that
      // opens. What Tulip's codec requires is the KEYS, not meaningful values:
      // `driver` and `event` are string codecs and "" is a string, so an empty
      // pairing validates where an empty OBJECT does not. That leaves the
      // device pickers blank rather than pointing at some other trigger's
      // device — and the step-level When lets the user switch to a machine
      // instead if that is what they meant.
      event.args =
        opts.args ||
        (sourceEvent.type === type && sourceEvent.args) ||
        (type === "interval" ? { interval: 30 } : { driver: "", event: "" });
    }
    trigger.event = event;

    // The binding. `delete`, never null — a null key fails Tulip's codec and
    // the paste is rejected before any request is made.
    if (klass === "app") {
      delete trigger.stepId;
      delete trigger.widgetId;
      trigger.haltOnError = true;
    } else if (klass === "step") {
      trigger.stepId = opts.stepId || trigger.stepId || next.sourceStepId;
      delete trigger.widgetId;
      trigger.haltOnError = true;
    } else {
      trigger.stepId = opts.stepId || trigger.stepId || next.sourceStepId;
      trigger.widgetId = opts.widgetId || trigger.widgetId;
      delete trigger.haltOnError;
    }
    return next;
  }

  // Fail closed: anything we don't positively recognize as a Tulip trigger
  // payload is left alone, and the paste simply doesn't happen. The format is
  // Tulip's private business and a release can change it.
  function usable(payload) {
    return !!(
      payload &&
      payload.isTulipAppClipboardContent === true &&
      payload.clipboardType === "Trigger" &&
      payload.trigger &&
      Array.isArray(payload.trigger.clauses) &&
      payload.trigger.event
    );
  }

  // ── handing it to Tulip ───────────────────────────────────────────────────
  // Tulip's paste handler reads text/html off the event's clipboardData, and
  // does not require a trusted event — so a ClipboardEvent built here enters
  // the dispatcher by the same door a real Ctrl+V does. (The event's own
  // clipboardData is read-only during a real paste, which is why this is a
  // fresh event rather than an edit of one.)
  function dispatchPaste(html) {
    const data = new DataTransfer();
    data.setData("text/html", html);
    const target = document.querySelector("#cssCanvas") || document.body;
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }

  function report(button, ok, error) {
    button.dispatchEvent(
      new CustomEvent(RESULT_EVENT, {
        bubbles: true,
        detail: JSON.stringify({ ok, error: error || null }),
      }),
    );
  }

  async function onClick(e) {
    if (!enabled()) return;
    const button = e.target && e.target.closest && e.target.closest("[" + BUTTON_ATTR + "]");
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();

    const destination = resolveDestination(button);
    if (!destination || !destination.type) {
      report(button, false, (destination && destination.error) || "Can't read target");
      return;
    }

    let payload;
    try {
      payload = await readClipboardPayload();
    } catch (_) {
      report(button, false, "Allow clipboard");
      return;
    }
    if (!usable(payload)) {
      report(button, false, "Copy a trigger first");
      return;
    }

    let rewritten;
    try {
      rewritten = rewrite(payload, destination.type, destination.opts);
    } catch (_) {
      report(button, false, "Paste failed");
      return;
    }

    debug("pasting as", { destination, event: rewritten.trigger.event });
    const handled = dispatchPaste(encode(rewritten));
    // Tulip owns everything past this point: it creates the trigger through
    // its own API and opens the editor. A refusal surfaces as Tulip's own
    // error toast — we never retry with a different shape.
    report(button, handled, handled ? null : "Tulip ignored the paste");
  }

  document.addEventListener("click", onClick, true);
})();
