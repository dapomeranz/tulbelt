// Bulk trigger-payload harvester for the copy/paste investigation
// (docs/paste-trigger-anywhere.md). Paste into the DevTools console of an app
// editor tab, page ("top") context. Standalone — it does not need the other
// probe, and the two coexist fine.
//
// Decoding one trigger at a time means copying each by hand and reading the
// clipboard, which needs page focus and therefore fights the console. This
// avoids both: it clicks each trigger row's own copy button and reads the
// payload out of the ClipboardItem Tulip passes to navigator.clipboard.write().
// That argument is just a Blob holder — no clipboard permission, no focus
// requirement, and it works even when the write itself is refused.
//
// Usage, once per surface (open the trigger list first):
//   await __harvest('app level')
//   await __harvest('step level')
//   await __harvest('custom widget X')
// then:
//   copy(__harvestJson)
//
// Copying is non-destructive — the only side effects are your clipboard ending
// up with the last trigger it clicked, and whatever Tulip does on a copy click.
// It never clicks a cut or delete control: only buttons that positively
// identify themselves as copy.

(() => {
  const harvested = [];

  // ── capture what Tulip hands the clipboard ─────────────────────────────────
  // Resolved with the payload text of the most recent write() call.
  let pendingWrite = null;

  const proto = window.Clipboard && window.Clipboard.prototype;
  const originalWrite = proto && proto.write;
  if (!originalWrite) {
    console.warn("[harvest] no Clipboard.prototype.write — cannot harvest here");
    return;
  }

  proto.write = function (items, ...rest) {
    try {
      const item = (items || []).find((i) => i && i.types && i.types.includes("text/html"));
      pendingWrite = item
        ? item
            .getType("text/html")
            .then((blob) => blob.text())
            .catch((err) => "(unreadable: " + String(err) + ")")
        : Promise.resolve(null);
    } catch (err) {
      pendingWrite = Promise.resolve("(hook failed: " + String(err) + ")");
    }
    // Let Tulip's own write proceed; a rejection here doesn't cost us the
    // payload, we already have it.
    return originalWrite.call(this, items, ...rest);
  };

  function decode(html) {
    if (!html) return null;
    const match = html.match(/data-tulip-clipboard="([^"]+)"/);
    if (!match) return { unparsed: html.slice(0, 400) };
    try {
      return JSON.parse(atob(match[1]));
    } catch (err) {
      return { decodeError: String(err) };
    }
  }

  // ── finding the rows and their copy buttons ────────────────────────────────
  const ROW_SELECTOR = '[class*="triggerRow"], [class*="triggerItem"], [data-testid^="trigger"]';
  const COPY_HINT = /copy/i;
  const DESTRUCTIVE_HINT = /cut|delete|remove|trash/i;

  function labelOf(el) {
    return [
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.getAttribute("data-testid"),
    ]
      .filter(Boolean)
      .join(" ");
  }

  function copyButtonIn(row) {
    for (const btn of row.querySelectorAll('button, [role="button"]')) {
      const label = labelOf(btn);
      if (!label) continue;
      if (DESTRUCTIVE_HINT.test(label)) continue;
      if (COPY_HINT.test(label)) return btn;
    }
    return null;
  }

  // The nearest short piece of text above the row — usually its section
  // heading ("App started", "On step enter", …).
  function sectionOf(row) {
    let node = row;
    for (let hops = 0; hops < 6 && node; hops++) {
      let sib = node.previousElementSibling;
      while (sib) {
        const text = (sib.textContent || "").trim();
        if (text && text.length <= 40 && !sib.matches(ROW_SELECTOR)) return text;
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return null;
  }

  function rowName(row) {
    return (row.textContent || "").trim().slice(0, 60);
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ── the harvest ────────────────────────────────────────────────────────────
  window.__harvest = async (surface = "unlabelled", { rowSelector, settleMs = 350 } = {}) => {
    const rows = [...document.querySelectorAll(rowSelector || ROW_SELECTOR)];
    const withButtons = rows
      .map((row) => ({ row, button: copyButtonIn(row) }))
      .filter((entry) => entry.button);

    console.log(
      "[harvest]",
      surface + ":",
      rows.length,
      "row(s),",
      withButtons.length,
      "with a copy button",
    );
    if (!withButtons.length) {
      console.warn(
        "[harvest] nothing to click. Open a trigger list first, or pass a selector: " +
          "__harvest('label', { rowSelector: '.something' })",
      );
      return [];
    }

    const found = [];
    for (const { row, button } of withButtons) {
      const name = rowName(row);
      const section = sectionOf(row);
      pendingWrite = null;
      try {
        button.click();
      } catch (err) {
        found.push({ surface, section, name, error: "click failed: " + String(err) });
        continue;
      }
      await wait(settleMs);
      if (!pendingWrite) {
        found.push({ surface, section, name, error: "copy click produced no clipboard write" });
        continue;
      }
      const payload = decode(await pendingWrite);
      const trigger = (payload && payload.trigger) || {};
      const entry = {
        surface,
        section,
        rowText: name,
        clipboardType: payload && payload.clipboardType,
        triggerName: trigger.name,
        event: trigger.event,
        stepId: trigger.stepId ?? null,
        widgetId: trigger.widgetId ?? null,
        // Any trigger key outside the shape already documented — a surface
        // that serializes differently shows up right here.
        unexpectedKeys: Object.keys(trigger).filter(
          (k) =>
            ![
              "id",
              "name",
              "versionSetId",
              "importFamilyId",
              "appVersionId",
              "stepId",
              "widgetId",
              "disabled",
              "workspaces",
              "created",
              "lastModified",
              "clauses",
              "event",
            ].includes(k),
        ),
      };
      found.push(entry);
      harvested.push(entry);
      console.log("[harvest]", surface, "→", JSON.stringify(entry));
    }

    window.__harvestJson = JSON.stringify(harvested, null, 2)
      .split(location.hostname)
      .join("your-instance.tulip.co");
    console.log("[harvest] total so far:", harvested.length, "— run copy(__harvestJson)");
    return found;
  };

  window.__harvestStop = () => {
    if (proto.write !== originalWrite) proto.write = originalWrite;
    return "clipboard write hook removed";
  };

  console.log(
    "[harvest] ready. Open a trigger list, then: await __harvest('app level')  →  copy(__harvestJson)",
  );
})();
