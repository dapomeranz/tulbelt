// Main-world half of submitted-pending-approvals.
//
// Runs at document_start in the MAIN world so our fetch/XHR patches are
// installed before any Tulip JavaScript executes.
//
// Captured state is written to data- attributes on <html> so the isolated-world
// half can read it. (The two worlds cannot share window.* properties — they have
// separate JS environments despite sharing the same DOM.)
//
//   data-tulbelt-sba-auth    = "Basic <base64>"
//   data-tulbelt-sba-uid     = userId  (e.g. "ndvTypJBi7ejyi2gM")
//   data-tulbelt-sba-wsid    = wsId    (e.g. "1")

(() => {
  const APPS_PENDING_RE = /\/api\/apps\/v1\/w\/(\d+)\/apps-pending-approval[/?]/;
  const APPS_LIST_RE    = /\/api\/apps\/v1\/w\/(\d+)\/(?:folders\/[^/?#]+\/)?apps(?:[?#]|$)/;
  const USER_URL_RE     = /\/api\/(?:apps|users)\/v\d+\/w\/(\d+)\/.*[?&]userId=([^&\s]+)/;

  const ROOT = document.documentElement;

  function setAuth(value) {
    if (value && !ROOT.hasAttribute("data-tulbelt-sba-auth")) {
      ROOT.setAttribute("data-tulbelt-sba-auth", value);
    }
  }

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

  function authFromHeaders(headers) {
    if (!headers) return null;
    try {
      if (typeof headers.get === "function") return headers.get("authorization");
      if (Array.isArray(headers)) {
        const hit = headers.find(([k]) => String(k).toLowerCase() === "authorization");
        return hit ? hit[1] : null;
      }
      if (typeof headers === "object") {
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === "authorization") return headers[k];
        }
      }
    } catch (_) {}
    return null;
  }

  // ── Patch fetch ─────────────────────────────────────────────────────────────

  const origFetch = window.fetch;
  if (typeof origFetch === "function" && !origFetch.__tulbeltSbaMain) {
    const wrapped = async function (...args) {
      try {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
        extractFromUrl(url);
        setAuth(authFromHeaders(args[1]?.headers));
      } catch (_) {}
      return origFetch.apply(this, args);
    };
    wrapped.__tulbeltSbaMain = true;
    window.fetch = wrapped;
  }

  // ── Patch XHR ───────────────────────────────────────────────────────────────

  const XHR = window.XMLHttpRequest;
  if (XHR && !XHR.prototype.__tulbeltSbaMain) {
    const origOpen      = XHR.prototype.open;
    const origSetHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url, ...rest) {
      try { extractFromUrl(url); } catch (_) {}
      return origOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.setRequestHeader = function (name, value) {
      try {
        if (String(name).toLowerCase() === "authorization") setAuth(value);
      } catch (_) {}
      return origSetHeader.call(this, name, value);
    };

    XHR.prototype.__tulbeltSbaMain = true;
  }
})();
