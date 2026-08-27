// Shared session sniffer. Runs at document_start in the MAIN world so the
// fetch/XHR patches are installed before any Tulip JavaScript executes.
//
// Tulip's own frontend authenticates its private API calls with an
// `Authorization: Basic <base64 of keyId:secret>` header — a session-scoped
// credential the app holds, not something the user configures. Rather than ask
// anyone to paste an API key, we let Tulip make its first API call and keep the
// header it sent. Same for the numeric workspace id: the browser URL carries a
// slug (`/w/DEFAULT/...`) while the API wants the number (`/api/v3/w/1/...`),
// so the number has to come off a real request.
//
// Captured state is written to data- attributes on <html> so isolated-world
// scripts can read it. (The two worlds cannot share window.* properties — they
// have separate JS environments despite sharing the same DOM.)
//
//   data-tulbelt-auth  = "Basic <base64>"
//   data-tulbelt-wsid  = workspace id (e.g. "1")
//
// Nothing is stored, sent anywhere, or persisted across page loads — the attrs
// live and die with the document.
//
// submitted-pending-approvals-main.js sniffs the same things under its own
// attribute names. The two patches chain (each wraps whatever fetch it finds),
// so both work; folding them together is a later cleanup.

(() => {
  const ROOT = document.documentElement;
  const AUTH_ATTR = "data-tulbelt-auth";
  const WSID_ATTR = "data-tulbelt-wsid";

  // Any versioned Tulip API path carrying a numeric workspace segment.
  const WSID_RE = /\/api\/[^/]+\/v\d+\/w\/(\d+)\//;

  // First writer wins: the earliest credential the app used is the one that
  // matches the session, and later calls may carry narrower scopes.
  function setAuth(value) {
    if (typeof value === "string" && value && !ROOT.hasAttribute(AUTH_ATTR)) {
      ROOT.setAttribute(AUTH_ATTR, value);
    }
  }

  function extractFromUrl(url) {
    if (typeof url !== "string") return;
    if (ROOT.hasAttribute(WSID_ATTR)) return;
    const m = WSID_RE.exec(url);
    if (m) ROOT.setAttribute(WSID_ATTR, m[1]);
  }

  // fetch() takes headers as a Headers instance, a plain object, or an array
  // of pairs — and the request may be a Request object carrying its own.
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
  if (typeof origFetch === "function" && !origFetch.__tulbeltSession) {
    const wrapped = async function (...args) {
      try {
        const input = args[0];
        const url = typeof input === "string" ? input : input?.url;
        extractFromUrl(url);
        setAuth(authFromHeaders(args[1]?.headers) || authFromHeaders(input?.headers));
      } catch (_) {}
      return origFetch.apply(this, args);
    };
    wrapped.__tulbeltSession = true;
    window.fetch = wrapped;
  }

  // ── Patch XHR ───────────────────────────────────────────────────────────────

  const XHR = window.XMLHttpRequest;
  if (XHR && !XHR.prototype.__tulbeltSession) {
    const origOpen = XHR.prototype.open;
    const origSetHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url, ...rest) {
      try {
        extractFromUrl(url);
      } catch (_) {}
      return origOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.setRequestHeader = function (name, value) {
      try {
        if (String(name).toLowerCase() === "authorization") setAuth(value);
      } catch (_) {}
      return origSetHeader.call(this, name, value);
    };

    XHR.prototype.__tulbeltSession = true;
  }
})();
