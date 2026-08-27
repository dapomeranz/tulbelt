// A Tulbelt-owned page reached from the account dropdown (the menu holding
// My profile / Sign out), which every user gets — unlike the account settings
// pages, which a restricted user can't open at all. That's why nothing here
// hangs off Tulip's settings sidebar.
//
// The page is a fixed full-window panel appended to <body>: its own Back bar
// and tab strip, owing nothing to Tulip's layout, so it renders the same at
// any permission level. Option Sets is the only tab today; the strip is
// driven by TABS so a second one is an entry in that array and nothing else.
//
// The URL is set with history.pushState to /tulbelt/<tab>, which React Router
// never observes — Tulip keeps rendering whatever it had underneath while we
// cover it. Nothing else in the app can be clicked while the panel is up, so
// Back (and Escape) is the only way out: it pops our own entry when we pushed
// one, and otherwise navigates somewhere real. A cold load of the fake URL
// works too (option-sets-trigger.js opens it in a new tab); Tulip's router
// may redirect the unknown route out from under us for a moment, so we take
// the URL back for a short window after load.
//
(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "option-sets-builder";
  const BASE_PATH = "/tulbelt";
  // The whole tab strip. Adding a page means adding an entry here (plus a
  // renderer keyed on its id in buildContainer) — nothing else.
  const TABS = [{ id: "option-sets", label: "Option Sets", path: `${BASE_PATH}/option-sets` }];
  const MENU_LI_ATTR = "data-tulbelt-osb-menu-item";
  const STYLE_ID = "tulbelt-osb-styles";
  const CONTAINER_ID = "tulbelt-osb-page";
  const PANEL_ID = "tulbelt-osb-panel";
  const LS_KEY = "tulbelt-option-sets";
  // How long after a cold load we keep reclaiming the URL from Tulip's router.
  const COLD_LOAD_GUARD_MS = 5000;

  const DATA_TYPES = [
    { id: "text", label: "Text" },
    { id: "integer", label: "Integer" },
    { id: "number", label: "Number" },
  ];

  let enabled = false;
  let active = false;
  let activeTabId = TABS[0].id;
  let observer = null;
  let scheduled = false;
  // Real Tulip path to fall back to when leaving the fake page.
  let lastRealPath = "/";
  // Set when the page cold-loaded on the fake URL; consumed on the first scan.
  let coldLoadWanted = false;
  let coldLoadGuardUntil = 0;
  // Whether we pushed a history entry for the fake URL — decides whether Back
  // can pop one or has to navigate somewhere real.
  let pushedEntry = false;

  const normalizePath = (p) => p.replace(/\/+$/, "") || "/";
  const isFakePath = (p = location.pathname) => {
    const n = normalizePath(p);
    return n === BASE_PATH || n.startsWith(`${BASE_PATH}/`);
  };
  const currentTab = () => TABS.find((t) => t.id === activeTabId) || TABS[0];
  // Bare /tulbelt (or an unknown tab) lands on the first tab.
  const tabForPath = (p = location.pathname) =>
    TABS.find((t) => t.path === normalizePath(p)) || TABS[0];

  // ── Option set data (tenant-origin localStorage) ────────────────────────────

  let data = null;
  let storageError = "";
  // UI state survives navigating away and back within the tab.
  const ui = { selectedId: null, creating: false, importing: false, confirmDelete: false, focus: null };

  function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function loadData() {
    storageError = "";
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return { version: 1, sets: [] };
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.sets)) return { version: 1, sets: [] };
      return parsed;
    } catch (err) {
      storageError = `Couldn't read saved option sets (${err.message}). Starting empty — saving will overwrite.`;
      return { version: 1, sets: [] };
    }
  }

  function saveData() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(data));
      if (storageError) {
        storageError = "";
        renderBanner();
      }
    } catch (err) {
      storageError = `Couldn't save option sets: ${err.message}`;
      renderBanner();
    }
  }

  function selectedSet() {
    return data.sets.find((s) => s.id === ui.selectedId) || null;
  }

  function touch(set) {
    set.updatedAt = Date.now();
    saveData();
  }

  function valueInvalid(type, raw) {
    const s = String(raw).trim();
    if (s === "") return true;
    if (type === "integer") return !/^-?\d+$/.test(s);
    if (type === "number") return !Number.isFinite(Number(s));
    return false;
  }

  // ── Export / import ─────────────────────────────────────────────────────────

  // Internal ids and timestamps are local bookkeeping — stripped on export,
  // regenerated on import.
  function exportText() {
    const payload = {
      tulbelt: "option-sets",
      version: 1,
      sets: data.sets.map((set) => ({
        name: set.name,
        description: set.description || "",
        dataType: set.dataType,
        options: set.options.map((o) => ({
          value: o.value == null ? "" : String(o.value),
          description: o.description || "",
        })),
      })),
    };
    return JSON.stringify(payload, null, 2);
  }

  // Returns { sets } ready to append, or { error } with nothing changed.
  // Unknown fields are ignored and version > 1 is accepted so payloads from
  // newer Tulbelt versions still import when the shape checks pass.
  function parseImportPayload(text) {
    if (!text.trim()) return { error: "Nothing to import." };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { error: `Not valid JSON (${err.message}).` };
    }
    if (!parsed || parsed.tulbelt !== "option-sets" || !Array.isArray(parsed.sets)) {
      return { error: "This doesn't look like a Tulbelt option sets export." };
    }
    const sets = [];
    for (const raw of parsed.sets) {
      if (!raw || typeof raw.name !== "string" || !raw.name.trim()) {
        return { error: "Every set in the export needs a name." };
      }
      if (!DATA_TYPES.some((t) => t.id === raw.dataType)) {
        return { error: `Set "${raw.name}" has an unknown data type "${raw.dataType}".` };
      }
      if (!Array.isArray(raw.options)) {
        return { error: `Set "${raw.name}" has no options list.` };
      }
      sets.push({
        id: newId("os"),
        name: raw.name,
        description: typeof raw.description === "string" ? raw.description : "",
        dataType: raw.dataType,
        options: raw.options.map((o) => ({
          id: newId("op"),
          value: o?.value == null ? "" : String(o.value),
          description: o?.description == null ? "" : String(o.description),
        })),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return { sets };
  }

  // ── Builder UI ──────────────────────────────────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function typeLabel(id) {
    return DATA_TYPES.find((t) => t.id === id)?.label || id;
  }

  function renderBanner() {
    const banner = document.querySelector(`#${CONTAINER_ID} .osb-banner`);
    if (!banner) return;
    banner.textContent = storageError;
    banner.style.display = storageError ? "" : "none";
  }

  function render() {
    const root = document.querySelector(`#${CONTAINER_ID} .osb-root`);
    if (!root) return;
    root.textContent = "";

    const banner = el("div", "osb-banner");
    banner.style.display = storageError ? "" : "none";
    banner.textContent = storageError;
    root.appendChild(banner);

    const layout = el("div", "osb-layout");
    layout.appendChild(renderListPanel());
    layout.appendChild(renderEditorPanel());
    root.appendChild(layout);

    // Focus requested by the action that triggered this render (add option,
    // create set, …).
    if (ui.focus) {
      root.querySelector(ui.focus)?.focus();
      ui.focus = null;
    }
  }

  function renderListPanel() {
    const panel = el("aside", "osb-list");
    const newBtn = el("button", "osb-btn osb-btn-primary", "+ New option set");
    newBtn.type = "button";
    newBtn.addEventListener("click", () => {
      ui.creating = true;
      ui.importing = false;
      ui.selectedId = null;
      ui.confirmDelete = false;
      ui.focus = ".osb-create-name";
      render();
    });
    panel.appendChild(newBtn);

    const tools = el("div", "osb-list-tools");
    const exportBtn = el("button", "osb-btn", "Export all");
    exportBtn.type = "button";
    exportBtn.disabled = data.sets.length === 0;
    exportBtn.addEventListener("click", () => {
      const count = data.sets.length;
      navigator.clipboard.writeText(exportText()).then(
        () => {
          exportBtn.textContent = `Copied ${count} set${count === 1 ? "" : "s"} ✓`;
          setTimeout(() => {
            if (exportBtn.isConnected) exportBtn.textContent = "Export all";
          }, 1500);
        },
        (err) => {
          storageError = `Couldn't copy to clipboard: ${err.message}`;
          renderBanner();
        }
      );
    });
    tools.appendChild(exportBtn);
    const importBtn = el("button", "osb-btn", "Import");
    importBtn.type = "button";
    importBtn.addEventListener("click", () => {
      ui.importing = true;
      ui.creating = false;
      ui.selectedId = null;
      ui.confirmDelete = false;
      ui.focus = ".osb-import-text";
      render();
    });
    tools.appendChild(importBtn);
    panel.appendChild(tools);

    if (data.sets.length === 0) {
      panel.appendChild(el("p", "osb-hint", "No option sets yet."));
      return panel;
    }

    const list = el("div", "osb-set-list");
    for (const set of data.sets) {
      const row = el("button", "osb-set-row" + (set.id === ui.selectedId ? " osb-selected" : ""));
      row.type = "button";
      const name = el("span", "osb-set-name", set.name || "(unnamed)");
      name.dataset.nameFor = set.id;
      row.appendChild(name);
      const meta = el("span", "osb-set-meta");
      meta.appendChild(el("span", "osb-badge", typeLabel(set.dataType)));
      meta.appendChild(el("span", "", `${set.options.length} option${set.options.length === 1 ? "" : "s"}`));
      row.appendChild(meta);
      row.addEventListener("click", () => {
        ui.selectedId = set.id;
        ui.creating = false;
        ui.importing = false;
        ui.confirmDelete = false;
        render();
      });
      list.appendChild(row);
    }
    panel.appendChild(list);
    return panel;
  }

  function renderEditorPanel() {
    const panel = el("section", "osb-editor");
    if (ui.creating) {
      panel.appendChild(renderCreateForm());
    } else if (ui.importing) {
      panel.appendChild(renderImportForm());
    } else {
      const set = selectedSet();
      if (set) panel.appendChild(renderSetEditor(set));
      else {
        panel.appendChild(
          el(
            "p",
            "osb-hint",
            data.sets.length
              ? "Select an option set on the left, or create a new one."
              : "Create your first option set to get started. Option sets are stored in this browser for this Tulip instance only."
          )
        );
      }
    }
    return panel;
  }

  function renderCreateForm() {
    const form = el("div", "osb-create");
    form.appendChild(el("h2", "", "New option set"));

    const nameLabel = el("label", "osb-field");
    nameLabel.appendChild(el("span", "osb-field-label", "Name"));
    const nameInput = el("input", "osb-input osb-create-name");
    nameInput.type = "text";
    nameInput.placeholder = "e.g. Defect Types";
    nameLabel.appendChild(nameInput);
    form.appendChild(nameLabel);

    const typeLabelEl = el("label", "osb-field");
    typeLabelEl.appendChild(el("span", "osb-field-label", "Data type"));
    const select = el("select", "osb-input");
    for (const t of DATA_TYPES) {
      const opt = el("option", "", t.label);
      opt.value = t.id;
      select.appendChild(opt);
    }
    typeLabelEl.appendChild(select);
    form.appendChild(typeLabelEl);
    form.appendChild(el("p", "osb-hint", "The data type is fixed once the set is created."));

    const actions = el("div", "osb-actions");
    const create = el("button", "osb-btn osb-btn-primary", "Create");
    create.type = "button";
    create.addEventListener("click", () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.classList.add("osb-invalid");
        nameInput.focus();
        return;
      }
      const set = {
        id: newId("os"),
        name,
        description: "",
        dataType: select.value,
        options: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      data.sets.push(set);
      saveData();
      ui.creating = false;
      ui.selectedId = set.id;
      render();
    });
    const cancel = el("button", "osb-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      ui.creating = false;
      render();
    });
    actions.appendChild(create);
    actions.appendChild(cancel);
    form.appendChild(actions);
    return form;
  }

  function renderImportForm() {
    const form = el("div", "osb-create");
    form.appendChild(el("h2", "", "Import option sets"));
    form.appendChild(
      el(
        "p",
        "osb-hint",
        "Paste an export from another Tulbelt user. Imported sets are added alongside your existing ones."
      )
    );
    const error = el("div", "osb-import-error");
    error.style.display = "none";
    form.appendChild(error);

    const text = el("textarea", "osb-input osb-import-text");
    text.rows = 10;
    text.placeholder = '{ "tulbelt": "option-sets", ... }';
    form.appendChild(text);

    const actions = el("div", "osb-actions");
    const doImport = el("button", "osb-btn osb-btn-primary", "Import");
    doImport.type = "button";
    doImport.addEventListener("click", () => {
      const result = parseImportPayload(text.value);
      if (result.error) {
        // No re-render — keep the pasted text so the user can fix it.
        error.textContent = result.error;
        error.style.display = "";
        return;
      }
      data.sets.push(...result.sets);
      saveData();
      ui.importing = false;
      ui.selectedId = result.sets[0]?.id ?? null;
      render();
    });
    const cancel = el("button", "osb-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      ui.importing = false;
      render();
    });
    actions.appendChild(doImport);
    actions.appendChild(cancel);
    form.appendChild(actions);
    return form;
  }

  function renderSetEditor(set) {
    const wrap = el("div", "osb-set-editor");

    // Header: name, type badge, delete with inline confirm.
    const header = el("div", "osb-editor-header");
    const nameInput = el("input", "osb-input osb-editor-name" + (set.name.trim() ? "" : " osb-invalid"));
    nameInput.type = "text";
    nameInput.value = set.name;
    nameInput.placeholder = "Option set name";
    nameInput.addEventListener("input", () => {
      set.name = nameInput.value;
      nameInput.classList.toggle("osb-invalid", !set.name.trim());
      const listName = document.querySelector(`[data-name-for="${set.id}"]`);
      if (listName) listName.textContent = set.name || "(unnamed)";
      touch(set);
    });
    header.appendChild(nameInput);
    header.appendChild(el("span", "osb-badge", typeLabel(set.dataType)));

    const del = el("div", "osb-delete");
    if (ui.confirmDelete) {
      del.appendChild(el("span", "", "Delete this set?"));
      const yes = el("button", "osb-btn osb-btn-danger", "Yes");
      yes.type = "button";
      yes.addEventListener("click", () => {
        data.sets = data.sets.filter((s) => s.id !== set.id);
        saveData();
        ui.selectedId = null;
        ui.confirmDelete = false;
        render();
      });
      const no = el("button", "osb-btn", "No");
      no.type = "button";
      no.addEventListener("click", () => {
        ui.confirmDelete = false;
        render();
      });
      del.appendChild(yes);
      del.appendChild(no);
    } else {
      const btn = el("button", "osb-btn", "Delete set");
      btn.type = "button";
      btn.addEventListener("click", () => {
        ui.confirmDelete = true;
        render();
      });
      del.appendChild(btn);
    }
    header.appendChild(del);
    wrap.appendChild(header);

    const desc = el("textarea", "osb-input osb-desc");
    desc.rows = 2;
    desc.placeholder = "Description (optional)";
    desc.value = set.description || "";
    desc.addEventListener("input", () => {
      set.description = desc.value;
      touch(set);
    });
    wrap.appendChild(desc);

    // Options.
    wrap.appendChild(el("h3", "osb-options-title", "Options"));
    if (set.options.length === 0) {
      wrap.appendChild(el("p", "osb-hint", "No options yet — add the first one."));
    } else {
      const list = el("div", "osb-options");
      set.options.forEach((option, index) => list.appendChild(renderOptionRow(set, option, index)));
      wrap.appendChild(list);
    }

    const add = el("button", "osb-btn osb-btn-primary", "+ Add option");
    add.type = "button";
    add.addEventListener("click", () => {
      const option = { id: newId("op"), value: "", description: "" };
      set.options.push(option);
      touch(set);
      ui.focus = `[data-opt-value="${option.id}"]`;
      render();
    });
    wrap.appendChild(add);
    return wrap;
  }

  function renderOptionRow(set, option, index) {
    const row = el("div", "osb-option-row");

    const move = el("div", "osb-move");
    const up = el("button", "osb-btn osb-btn-icon", "▲");
    up.type = "button";
    up.disabled = index === 0;
    up.title = "Move up";
    const down = el("button", "osb-btn osb-btn-icon", "▼");
    down.type = "button";
    down.disabled = index === set.options.length - 1;
    down.title = "Move down";
    const swap = (delta) => {
      const target = index + delta;
      [set.options[index], set.options[target]] = [set.options[target], set.options[index]];
      touch(set);
      render();
    };
    up.addEventListener("click", () => swap(-1));
    down.addEventListener("click", () => swap(1));
    move.appendChild(up);
    move.appendChild(down);
    row.appendChild(move);

    const value = el(
      "input",
      "osb-input osb-opt-value" + (valueInvalid(set.dataType, option.value) ? " osb-invalid" : "")
    );
    value.dataset.optValue = option.id;
    if (set.dataType === "integer") {
      value.type = "number";
      value.step = "1";
    } else if (set.dataType === "number") {
      value.type = "number";
      value.step = "any";
    } else {
      value.type = "text";
    }
    value.placeholder = "Value";
    value.value = option.value;
    value.addEventListener("input", () => {
      option.value = value.value;
      value.classList.toggle("osb-invalid", valueInvalid(set.dataType, option.value));
      touch(set);
    });
    row.appendChild(value);

    const desc = el("input", "osb-input osb-opt-desc");
    desc.type = "text";
    desc.placeholder = "Description (optional)";
    desc.value = option.description || "";
    desc.addEventListener("input", () => {
      option.description = desc.value;
      touch(set);
    });
    row.appendChild(desc);

    const remove = el("button", "osb-btn osb-btn-icon", "✕");
    remove.type = "button";
    remove.title = "Remove option";
    remove.addEventListener("click", () => {
      set.options = set.options.filter((o) => o.id !== option.id);
      touch(set);
      render();
    });
    row.appendChild(remove);
    return row;
  }

  // ── DOM discovery ───────────────────────────────────────────────────────────

  // The account dropdown — anchored on My profile, which every user gets, not
  // on the settings entries a restricted user may be missing.
  function findUserMenuUl() {
    return document.querySelector('li[data-testid="my-profile-menuitem"]')?.closest("ul") || null;
  }

  // ── Styles / container ──────────────────────────────────────────────────────

  const CSS = `
      #${PANEL_ID} {
        position: fixed; inset: 0; z-index: 2147483000; display: flex; flex-direction: column;
        background: #fff; color: #1a1f28;
        font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      #${PANEL_ID} .osb-panel-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #f6f8fb; }
      #${PANEL_ID} .osb-panel-title { font-size: 1.15em; font-weight: 600; }
      #${PANEL_ID} .osb-panel-brand { margin-left: auto; color: #788293; font-size: 0.85em; }
      #${PANEL_ID} .osb-panel-back { font: inherit; padding: 6px 12px; border: 1px solid #d5dae2; border-radius: 4px; background: #fff; color: inherit; cursor: pointer; }
      #${PANEL_ID} .osb-panel-back:hover { border-color: #1c69e1; }
      #${PANEL_ID} .osb-tabs { flex: 0 0 auto; display: flex; gap: 4px; padding: 0 16px; background: #f6f8fb; border-bottom: 1px solid #d5dae2; }
      #${PANEL_ID} .osb-tab { font: inherit; padding: 8px 14px; border: none; border-bottom: 2px solid transparent; background: none; color: #45526b; cursor: pointer; }
      #${PANEL_ID} .osb-tab:hover { color: #1c69e1; }
      #${PANEL_ID} .osb-tab-on { color: #1c69e1; border-bottom-color: #1c69e1; font-weight: 600; }
      #${CONTAINER_ID} { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 24px 40px; }
      #${CONTAINER_ID} h2 { font-size: 1.15em; margin: 0 0 12px; }
      #${CONTAINER_ID} .osb-disclaimer { background: #eef4fd; color: #45526b; border: 1px solid #c9dcf7; border-radius: 4px; padding: 8px 12px; margin-bottom: 16px; }
      #${CONTAINER_ID} .osb-banner { background: #fdecea; color: #b3261e; border: 1px solid #f5c6c2; border-radius: 4px; padding: 8px 12px; margin-bottom: 12px; }
      #${CONTAINER_ID} .osb-layout { display: flex; gap: 24px; align-items: flex-start; }
      #${CONTAINER_ID} .osb-list { flex: 0 0 240px; display: flex; flex-direction: column; gap: 8px; }
      #${CONTAINER_ID} .osb-list-tools { display: flex; gap: 6px; }
      #${CONTAINER_ID} .osb-list-tools .osb-btn { flex: 1 1 0; white-space: nowrap; }
      #${CONTAINER_ID} .osb-set-list { display: flex; flex-direction: column; gap: 4px; }
      #${CONTAINER_ID} .osb-set-row { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 8px 10px; border: 1px solid #d5dae2; border-radius: 6px; background: #fff; cursor: pointer; font: inherit; }
      #${CONTAINER_ID} .osb-set-row:hover { border-color: #1c69e1; }
      #${CONTAINER_ID} .osb-set-row.osb-selected { border-color: #1c69e1; background: #eef4fd; }
      #${CONTAINER_ID} .osb-set-name { font-weight: 600; }
      #${CONTAINER_ID} .osb-set-meta { display: flex; gap: 8px; align-items: center; color: #788293; font-size: 0.85em; }
      #${CONTAINER_ID} .osb-badge { display: inline-block; padding: 1px 8px; border-radius: 10px; background: #e8edf5; color: #45526b; font-size: 0.8em; white-space: nowrap; }
      #${CONTAINER_ID} .osb-editor { flex: 1 1 auto; min-width: 0; max-width: 720px; }
      #${CONTAINER_ID} .osb-hint { color: #788293; margin: 8px 0; }
      #${CONTAINER_ID} .osb-input { font: inherit; padding: 6px 8px; border: 1px solid #d5dae2; border-radius: 4px; background: #fff; color: inherit; }
      #${CONTAINER_ID} .osb-input:focus { outline: none; border-color: #1c69e1; }
      #${CONTAINER_ID} .osb-input.osb-invalid { border-color: #b3261e; }
      #${CONTAINER_ID} .osb-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; max-width: 320px; }
      #${CONTAINER_ID} .osb-field-label { font-weight: 600; font-size: 0.9em; }
      #${CONTAINER_ID} .osb-actions { display: flex; gap: 8px; margin-top: 8px; }
      #${CONTAINER_ID} .osb-btn { font: inherit; padding: 6px 12px; border: 1px solid #d5dae2; border-radius: 4px; background: #fff; color: inherit; cursor: pointer; }
      #${CONTAINER_ID} .osb-btn:hover:not(:disabled) { border-color: #1c69e1; }
      #${CONTAINER_ID} .osb-btn:disabled { opacity: 0.4; cursor: default; }
      #${CONTAINER_ID} .osb-btn-primary { background: #1c69e1; border-color: #1c69e1; color: #fff; }
      #${CONTAINER_ID} .osb-btn-danger { background: #b3261e; border-color: #b3261e; color: #fff; }
      #${CONTAINER_ID} .osb-btn-icon { padding: 2px 8px; line-height: 1.2; }
      #${CONTAINER_ID} .osb-editor-header { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
      #${CONTAINER_ID} .osb-editor-name { flex: 1 1 auto; min-width: 0; font-weight: 600; }
      #${CONTAINER_ID} .osb-delete { display: flex; gap: 6px; align-items: center; white-space: nowrap; }
      #${CONTAINER_ID} .osb-desc { width: 100%; box-sizing: border-box; resize: vertical; margin-bottom: 8px; }
      #${CONTAINER_ID} .osb-options-title { font-size: 1em; margin: 12px 0 6px; }
      #${CONTAINER_ID} .osb-options { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
      #${CONTAINER_ID} .osb-option-row { display: flex; gap: 8px; align-items: center; }
      #${CONTAINER_ID} .osb-move { display: flex; flex-direction: column; gap: 2px; }
      #${CONTAINER_ID} .osb-move .osb-btn-icon { padding: 0 6px; font-size: 0.7em; }
      #${CONTAINER_ID} .osb-opt-value { flex: 0 1 200px; min-width: 100px; }
      #${CONTAINER_ID} .osb-opt-desc { flex: 1 1 auto; min-width: 0; }
      #${CONTAINER_ID} .osb-import-text { width: 100%; box-sizing: border-box; resize: vertical; font-family: ui-monospace, Menlo, monospace; font-size: 0.85em; margin-bottom: 4px; }
      #${CONTAINER_ID} .osb-import-error { background: #fdecea; color: #b3261e; border: 1px solid #f5c6c2; border-radius: 4px; padding: 8px 12px; margin-bottom: 8px; }
    `;

  // The active tab's content. One tab today, so this is unconditional; a
  // second one branches on container.dataset.tab here and in render().
  function buildContainer() {
    const container = document.createElement("div");
    container.id = CONTAINER_ID;
    container.dataset.tab = activeTabId;
    container.appendChild(
      el(
        "div",
        "osb-disclaimer",
        "This is a local-only menu provided by the Tulbelt plugin. Option sets are stored in your browser and written to Tulip as regular static values when used. They will not be shared with any other users, as Tulbelt does not have access to any data storage other than your browser."
      )
    );
    container.appendChild(el("div", "osb-root"));
    // Reload from localStorage on every activation so edits from another tab
    // on this tenant show up after navigating away and back.
    data = loadData();
    return container;
  }

  // ── Nav item ────────────────────────────────────────────────────────────────

  // The one entry point: an item in the account dropdown. The clone carries no
  // React fiber, so Tulip's delegated handlers never fire for it — the link is
  // entirely ours.
  function injectMenuLi() {
    const ul = findUserMenuUl();
    if (!ul || ul.querySelector(`li[${MENU_LI_ATTR}]`)) return;
    const items = [...ul.children].filter((n) => n.tagName === "LI");
    const links = items.filter((n) => n.querySelector("a[href]"));
    const template = links[links.length - 1];
    if (!template) return;
    const li = template.cloneNode(true);
    li.setAttribute(MENU_LI_ATTR, "");
    li.setAttribute("data-testid", "tulbelt-menuitem");
    // `value` is how Tulip's menu identifies a row; ours must not impersonate
    // the one we cloned.
    li.removeAttribute("value");
    li.setAttribute("href", TABS[0].path);
    const a = li.querySelector("a");
    a.setAttribute("href", TABS[0].path);
    a.setAttribute("data-testid", "tulbelt");
    const label = a.querySelector("span") || a;
    label.textContent = "Tulbelt";
    a.addEventListener("click", onMenuLinkClick);
    // Above Sign out — the only row that is a button rather than a link.
    const signOut = items.find((n) => !n.querySelector("a[href]"));
    if (signOut) signOut.before(li);
    else ul.appendChild(li);
  }

  function removeMenuLi() {
    document.querySelector(`li[${MENU_LI_ATTR}]`)?.remove();
  }

  // ── Activate / deactivate ───────────────────────────────────────────────────

  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    const bar = el("div", "osb-panel-bar");
    const back = el("button", "osb-panel-back", "← Back");
    back.type = "button";
    back.title = "Leave Tulbelt and return to Tulip";
    back.addEventListener("click", goBack);
    bar.appendChild(back);
    bar.appendChild(el("span", "osb-panel-title", "Tulbelt"));
    bar.appendChild(el("span", "osb-panel-brand", "Browser extension — nothing here leaves this browser"));
    panel.appendChild(bar);

    const tabs = el("div", "osb-tabs");
    tabs.setAttribute("role", "tablist");
    for (const tab of TABS) {
      const btn = el("button", "osb-tab", tab.label);
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.dataset.tabId = tab.id;
      btn.addEventListener("click", () => selectTab(tab.id));
      tabs.appendChild(btn);
    }
    panel.appendChild(tabs);
    return panel;
  }

  function applyActive() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = buildPanel();
      document.body.appendChild(panel);
    }
    for (const btn of panel.querySelectorAll(".osb-tab")) {
      const on = btn.dataset.tabId === activeTabId;
      btn.classList.toggle("osb-tab-on", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
    const container = document.getElementById(CONTAINER_ID);
    if (!container || container.dataset.tab !== activeTabId) {
      container?.remove();
      panel.appendChild(buildContainer());
      render();
    }
  }

  function selectTab(id) {
    if (!TABS.some((t) => t.id === id) || activeTabId === id) return;
    activeTabId = id;
    // replaceState, not push: Back should leave Tulbelt, not walk the tabs.
    history.replaceState(null, "", currentTab().path);
    applyActive();
  }

  function activate() {
    if (active) return;
    if (!isFakePath()) lastRealPath = location.pathname;
    activeTabId = tabForPath().id;
    active = true;
    ensureStyles(STYLE_ID, CSS);
    applyActive();
  }

  function deactivate({ restoreUrl }) {
    if (!active) return;
    active = false;
    document.getElementById(CONTAINER_ID)?.remove();
    document.getElementById(PANEL_ID)?.remove();
    pushedEntry = false;
    if (restoreUrl && isFakePath()) history.replaceState(null, "", lastRealPath);
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  function pushFake(path = TABS[0].path) {
    history.pushState(null, "", path);
    pushedEntry = true;
  }

  // The menu item. This deliberately lets the click propagate so Tulip's popup
  // dismissal still sees it; the synthetic Escape is the fallback for builds
  // that only close on a keyed dismiss. Dispatched from the link, not document
  // — React delegates from its root container, so an event fired on document
  // never reaches the popup — and before activating, because our own Escape
  // handler bails while the page is closed. That ordering is what stops this
  // from immediately closing the page it's opening.
  function onMenuLinkClick(e) {
    e.preventDefault();
    if (!enabled || active) return;
    e.currentTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    lastRealPath = isFakePath() ? lastRealPath : location.pathname;
    pushFake();
    activate();
  }

  // The panel covers the window, so this is the only way out. Popping our own
  // entry is the honest route; a cold load onto the fake URL has none, so
  // leave for wherever Tulip last was (or the app root).
  function goBack() {
    if (pushedEntry) {
      history.back(); // popstate → deactivate
      return;
    }
    deactivate({ restoreUrl: false });
    location.assign(lastRealPath || "/");
  }

  function onKeyDown(e) {
    if (e.key !== "Escape" || !active) return;
    if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
    goBack();
  }

  function onPopState() {
    if (!enabled) return;
    if (isFakePath()) {
      // Back/forward between tabs, or onto the page from outside it.
      activeTabId = tabForPath().id;
      if (active) applyActive();
      else activate();
    } else {
      deactivate({ restoreUrl: false });
    }
  }

  // ── Observer loop ───────────────────────────────────────────────────────────

  function ensure() {
    injectMenuLi();
    if (coldLoadWanted && !active) {
      coldLoadWanted = false;
      activate();
      return;
    }
    if (!active) return;
    // A cold load lands on a route Tulip doesn't know; its router may redirect
    // out from under us a moment later. Take the URL back — replaceState, so
    // the history we'd pop is untouched — and keep where it wanted to go as
    // the exit path.
    if (performance.now() < coldLoadGuardUntil && !isFakePath()) {
      lastRealPath = location.pathname;
      history.replaceState(null, "", currentTab().path);
    }
    applyActive();
  }

  function scheduleEnsure() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (enabled) ensure();
    });
  }

  function start() {
    ensureStyles(STYLE_ID, CSS);
    coldLoadWanted = isFakePath();
    if (coldLoadWanted) {
      coldLoadGuardUntil = performance.now() + COLD_LOAD_GUARD_MS;
      // A late redirect usually arrives with a render, but don't rely on the
      // mutation that carries it being the last one.
      setTimeout(scheduleEnsure, 300);
      setTimeout(scheduleEnsure, 1500);
    }
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("popstate", onPopState);
    observer = new MutationObserver(scheduleEnsure);
    observer.observe(document.body, { childList: true, subtree: true });
    ensure();
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("popstate", onPopState);
    deactivate({ restoreUrl: true });
    removeMenuLi();
    removeStyles(STYLE_ID);
  }

  registerToggle(FEATURE_ID, {
    onEnable() {
      enabled = true;
      start();
    },
    onDisable() {
      enabled = false;
      stop();
    },
  });
})();
