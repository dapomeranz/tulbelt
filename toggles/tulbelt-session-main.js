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
// The two worlds cannot share window.* properties (they have separate JS
// environments despite sharing the same DOM), so isolated-world scripts need
// another way to get at what this captures:
//
//   * The credential stays in this script and never goes into the DOM, where
//     everything that reads the page's HTML would get it: a saved page, a
//     DOM snapshot, a session recorder, an extension that sends the page
//     somewhere. An isolated-world script asks for it instead (lib.js's
//     sessionAuth): it dispatches SESSION_REQUEST on document, and this
//     answers during that dispatch with a SESSION_EVENT whose detail is the
//     header. (A string detail crosses between the worlds.) When the header
//     is first captured, CAPTURED_EVENT goes out, without it, for anything
//     waiting: that asks. It's a separate event so a waiter that asks when it
//     hears one doesn't hear its own answer, and ask again, without end.
//     Page scripts can ask too, but the page is what made the credential;
//     what this keeps it out of is the HTML.
//   * The workspace id is no secret, so it goes on <html>:
//       data-tulbelt-wsid  = workspace id (e.g. "1")
//
// Nothing is stored, sent anywhere, or persisted across page loads — it all
// lives and dies with the document.
//
// submitted-pending-approvals-main.js sniffs the workspace and user ids under
// its own attribute names. The two patches chain (each wraps whatever fetch it
// finds), so both work; folding them together is a later cleanup.

(() => {
  const ROOT = document.documentElement;
  const WSID_ATTR = "data-tulbelt-wsid";
  const SESSION_REQUEST = "tulbelt:session-request";
  const SESSION_EVENT = "tulbelt:session";
  const CAPTURED_EVENT = "tulbelt:session-captured";

  let auth = "";

  document.addEventListener(SESSION_REQUEST, () => {
    if (auth) document.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail: auth }));
  });

  // Any versioned Tulip API path carrying a numeric workspace segment.
  const WSID_RE = /\/api\/[^/]+\/v\d+\/w\/(\d+)\//;

  // First writer wins: the earliest credential the app used is the one that
  // matches the session, and later calls may carry narrower scopes.
  function setAuth(value) {
    if (typeof value === "string" && value && !auth) {
      auth = value;
      document.dispatchEvent(new CustomEvent(CAPTURED_EVENT));
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
