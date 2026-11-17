// Main-world half of submitted-pending-approvals.
//
// Runs at document_start in the MAIN world so our fetch/XHR patches are
// installed before any Tulip JavaScript executes.
//
// Captured state is written to data- attributes on <html> so the isolated-world
// half can read it. (The two worlds cannot share window.* properties — they have
// separate JS environments despite sharing the same DOM.)
//
//   data-tulbelt-sba-uid     = userId  (e.g. "ndvTypJBi7ejyi2gM")
//   data-tulbelt-sba-wsid    = wsId    (e.g. "1")
//
// The credential isn't captured here: it would have to go on <html> too, where
// anything reading the page's HTML gets it. The isolated half uses the session
// one, which tulbelt-session-main.js keeps out of the DOM.

(() => {
  const APPS_PENDING_RE = /\/api\/apps\/v1\/w\/(\d+)\/apps-pending-approval[/?]/;
  const APPS_LIST_RE = /\/api\/apps\/v1\/w\/(\d+)\/(?:folders\/[^/?#]+\/)?apps(?:[?#]|$)/;
  const USER_URL_RE = /\/api\/(?:apps|users)\/v\d+\/w\/(\d+)\/.*[?&]userId=([^&\s]+)/;

  const ROOT = document.documentElement;

  function extractFromUrl(url) {
    if (typeof url !== "string") return;
    const pm = APPS_PENDING_RE.exec(url) || APPS_LIST_RE.exec(url);
    if (pm && !ROOT.hasAttribute("data-tulbelt-sba-wsid")) {
      ROOT.setAttribute("data-tulbelt-sba-wsid", pm[1]);
    }
    const um = USER_URL_RE.exec(url);
    if (um) {
      if (!ROOT.hasAttribute("data-tulbelt-sba-wsid"))
        ROOT.setAttribute("data-tulbelt-sba-wsid", um[1]);
      if (!ROOT.hasAttribute("data-tulbelt-sba-uid"))
        ROOT.setAttribute("data-tulbelt-sba-uid", decodeURIComponent(um[2]));
    }
  }

  // ── Patch fetch ─────────────────────────────────────────────────────────────

  const origFetch = window.fetch;
  if (typeof origFetch === "function" && !origFetch.__tulbeltSbaMain) {
    const wrapped = async function (...args) {
      try {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
        extractFromUrl(url);
      } catch (_) {}
      return origFetch.apply(this, args);
    };
    wrapped.__tulbeltSbaMain = true;
    window.fetch = wrapped;
  }

  // ── Patch XHR ───────────────────────────────────────────────────────────────

  const XHR = window.XMLHttpRequest;
  if (XHR && !XHR.prototype.__tulbeltSbaMain) {
    const origOpen = XHR.prototype.open;

    XHR.prototype.open = function (method, url, ...rest) {
      try {
        extractFromUrl(url);
      } catch (_) {}
      return origOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.__tulbeltSbaMain = true;
  }
})();
