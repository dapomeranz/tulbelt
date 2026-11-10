// MAIN-world half of record-history. Tulip's Record History widget does not
// read a REST endpoint: it calls the Meteor method `getHistoryRecord` over the
// page's own DDP connection, which is where the audit trail behind a table
// record (the "temporal table") is served from. Meteor lives in the page's JS
// environment, so the isolated half cannot reach it — it sends a request here
// and this half makes the same call the widget makes.
//
//   getHistoryRecord({ ddmId, ddmRecordId, minDate, maxDate, filters,
//                      hideProcessData, signedCompletionsOnly, isExport })
//     → { historyRecord: [eventGroup], isLimited, minDate }
//
// Requests arrive as `tulbelt:rh-request` on document and are answered with
// `tulbelt:rh-response`; both carry a JSON string as the detail (object details
// don't reliably cross the world boundary).
//
// The one thing JSON would spoil is the paging cursor. When a history is long
// the method answers `isLimited` with the `minDate` it stopped at, and the
// widget asks for the next slice by passing that value back as `maxDate`. It
// is whatever EJSON gave us — a Date, most likely — and a round trip through
// JSON would hand the server a string instead. So the raw value stays on this
// side under a token, and the isolated half sends the token back.
//
// It also answers whether the instance has record history at all. Tulip hides
// the widget unless the plan feature `tableAuditLog` is on — "Persist audit
// history for table and record changes" — and without it there is no history
// to show, so the isolated half exposes nothing until this says yes. The
// feature is on when the instance's plan includes it or an override grants it,
// and both live in two small client collections (`Plans`, `PlanOverrides`)
// fed by the `pricing_plans` subscription. That is where Tulip's own check
// reads them from, so we subscribe and read the same documents.
//
// Passive otherwise: it only reacts to events from the isolated half (which is
// gated by the toggle), reads nothing but what it is asked for, and never
// touches the DOM. The one thing it holds is that subscription, which the
// isolated half releases (`release`) when the toggle goes off.

(() => {
  const REQUEST_EVENT = "tulbelt:rh-request";
  const RESPONSE_EVENT = "tulbelt:rh-response";

  // Raw `minDate` cursors by token. A handful per session; never cleared
  // because a "Load more" can come long after the slice it continues.
  const cursors = new Map();
  let nextCursor = 1;

  // Tulip's bundle imports Meteor through webpack, but the Meteor runtime
  // itself is a classic script that publishes `Package` (and usually `Meteor`)
  // on window.
  function meteor() {
    return window.Meteor || window.Package?.meteor?.Meteor || null;
  }

  // ── Does this instance record history? ──────────────────────────────────────

  const HISTORY_FEATURE = "tableAuditLog";
  // Plans whose defaults include the feature, from the plan table in Tulip's
  // bundle. Every other plan needs an override to get it.
  const PLANS_WITH_HISTORY = ["regulated"];
  // Tulip's own fallback when no plan document has arrived.
  const DEFAULT_PLAN = "enterprise";
  const PLAN_WAIT_MS = 15000;

  let planSub = null;

  // Resolves true once the plan documents are on the client.
  function planReady() {
    return new Promise((resolve) => {
      const M = meteor();
      if (!M || typeof M.subscribe !== "function") {
        resolve(false);
        return;
      }
      try {
        if (planSub?.ready()) {
          resolve(true);
          return;
        }
        planSub?.stop();
      } catch (_) {}
      const timer = setTimeout(() => resolve(false), PLAN_WAIT_MS);
      const settle = (ok) => () => {
        clearTimeout(timer);
        resolve(ok);
      };
      planSub = M.subscribe("pricing_plans", { onReady: settle(true), onStop: settle(false) });
    });
  }

  function documents(name) {
    const collection = meteor()?.connection?._mongo_livedata_collections?.[name];
    return collection ? collection.find().fetch() : null;
  }

  // `known: false` means "can't tell yet" — nobody signed in, Meteor not up,
  // the plan not delivered — and the isolated half asks again later. Only a
  // `known` answer is ever acted on. The rule is Tulip's: an override that is
  // on, or a plan that has the feature by default.
  async function historyAvailable() {
    const M = meteor();
    let userId = null;
    try {
      userId = M?.userId?.() ?? null;
    } catch (_) {}
    if (!userId) return { known: false };
    if (!(await planReady())) return { known: false };
    const plans = documents("Plans");
    const overrides = documents("PlanOverrides");
    if (!plans || !overrides) return { known: false };
    const plan = plans[0]?.type ?? DEFAULT_PLAN;
    const override = overrides.find((o) => o?.name === HISTORY_FEATURE)?.value;
    return { known: true, enabled: override === true || PLANS_WITH_HISTORY.includes(plan), plan };
  }

  function releasePlan() {
    try {
      planSub?.stop();
    } catch (_) {}
    planSub = null;
  }

  function callMethod(name, arg) {
    return new Promise((resolve, reject) => {
      const M = meteor();
      if (!M || typeof M.call !== "function") {
        reject(new Error("Tulip's Meteor client isn't available on this page yet."));
        return;
      }
      M.call(name, arg, (err, result) => {
        if (err) reject(new Error(err.reason || err.message || String(err.error || err)));
        else resolve(result);
      });
    });
  }

  async function history(req) {
    const arg = {
      ddmId: req.tableId,
      ddmRecordId: req.recordId,
      filters: [],
      hideProcessData: req.hideProcessData === true,
      signedCompletionsOnly: req.signedCompletionsOnly === true,
    };
    if (req.cursor && cursors.has(req.cursor)) arg.maxDate = cursors.get(req.cursor);
    if (req.all === true) arg.isExport = true;

    const result = (await callMethod("getHistoryRecord", arg)) || {};
    let cursor = "";
    if (result.isLimited && result.minDate != null) {
      cursor = `c${nextCursor++}`;
      cursors.set(cursor, result.minDate);
    }
    return {
      historyRecord: Array.isArray(result.historyRecord) ? result.historyRecord : [],
      isLimited: result.isLimited === true,
      minDate: result.minDate ?? null,
      cursor,
    };
  }

  function respond(id, body) {
    let detail;
    try {
      detail = JSON.stringify({ id, ...body });
    } catch (err) {
      detail = JSON.stringify({ id, ok: false, error: `Unreadable response: ${err.message}` });
    }
    document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail }));
  }

  document.addEventListener(REQUEST_EVENT, async (e) => {
    let req;
    try {
      req = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    if (!req || typeof req.id !== "string") return;
    try {
      if (req.op === "available") {
        respond(req.id, { ok: true, result: await historyAvailable() });
      } else if (req.op === "release") {
        releasePlan();
        respond(req.id, { ok: true, result: {} });
      } else if (req.op === "history") {
        if (typeof req.tableId !== "string" || typeof req.recordId !== "string") {
          throw new Error("A table id and a record id are both required.");
        }
        respond(req.id, { ok: true, result: await history(req) });
      }
    } catch (err) {
      respond(req.id, { ok: false, error: err?.message || String(err) });
    }
  });
})();
