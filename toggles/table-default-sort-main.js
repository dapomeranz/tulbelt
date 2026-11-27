// Main-world half of table-default-sort. Lives in `world: "MAIN"` at
// document_start so its wrappers are on history.pushState/replaceState before
// Tulip's router runs.
//
// A full load of a table URL is sorted by the declarativeNetRequest redirect in
// features.js. Opening a table from inside Tulip is a history.pushState the
// network never sees, so it needs this half. The service worker used to cover
// that by reloading the tab onto the sorted URL, which threw the whole app away
// on every table opened: Tulip booted again and had to resume its session each
// time, the unsorted records were fetched first anyway, and the extra history
// entry made Back "go to itself".
//
// Instead, once Tulip has pushed (or replaced) a bare table URL, this swaps that
// same history entry for the sorted URL and fires popstate. Tulip's router takes
// it as the browser moving there: it reads the address bar again, and the table
// page sees `sortOptions` and fetches newest first. No reload and no extra entry,
// so Back leaves the table just as it would without the toggle. history.state is
// passed through untouched, since the router keys its entries on it. It runs on
// the next task, so the router has finished its own navigation first.
//
// Only a URL with no query at all is sorted, as with the redirect: one that
// already says how to sort or page is the user's (or Tulip's) choice.
// Back/Forward never calls pushState, so it's never re-sorted.
//
// The isolated half (table-default-sort.js) says whether the toggle is on with
// an attribute on <html>. The wrappers stay installed for the life of the page
// (Tulip's router holds on to the history object); with the toggle off they do
// nothing.

(() => {
  const ENABLED_ATTR = "data-tulbelt-table-sort-enabled";
  const SORT_QUERY =
    "sortOptions=%5B%7B%22sortBy%22%3A%22_createdAt%22%2C%22sortDir%22%3A%22desc%22%7D%5D&offset=0";
  // The redirect rule's paths: /table/<id>…, with or without a /w/<workspace> prefix.
  const TABLE_PATH_RE = /^(?:\/w\/[^/]+)?\/table\/./;
  // Should Tulip ever take the query straight back off, sorting the same table
  // again at once would never end. A later visit to it is sorted as usual.
  const RESORT_GAP_MS = 2000;

  const replaceState = history.replaceState;
  let lastPath = "";
  let lastAt = -Infinity;

  function enabled() {
    return document.documentElement.getAttribute(ENABLED_ATTR) === "true";
  }

  function sortInPlace() {
    if (!enabled() || location.search || !TABLE_PATH_RE.test(location.pathname)) return;
    const now = performance.now();
    if (location.pathname === lastPath && now - lastAt < RESORT_GAP_MS) return;
    lastPath = location.pathname;
    lastAt = now;
    replaceState.call(
      history,
      history.state,
      "",
      `${location.pathname}?${SORT_QUERY}${location.hash}`,
    );
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }

  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    history[name] = function (...args) {
      const result = original.apply(this, args);
      try {
        if (enabled()) setTimeout(sortInPlace, 0);
      } catch (_) {}
      return result;
    };
  }
})();
