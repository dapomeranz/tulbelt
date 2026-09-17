// Which flags mark an archived table or column? Paste into the devtools
// console on any Tulip page (with Tulbelt loaded, so the sniffed session
// header is on <html>). Prints, for the workspace's table list and the first
// table's metadata, every "gone"-looking field each item carries — the shape
// toggles/data-queries.js's isArchived() guesses at, seen for real.
//
// Archive a table and a column first if the tenant has none; otherwise every
// row will simply show no flags, which is also an answer.
(async () => {
  const html = document.documentElement;
  const ws = html.getAttribute("data-tulbelt-wsid") || "1";
  const auth = html.getAttribute("data-tulbelt-auth") || "";
  const headers = { Accept: "application/json" };
  if (auth) headers.Authorization = auth;
  const get = (path) =>
    fetch(`${location.origin}${path}`, { credentials: "include", headers }).then((r) => r.json());

  const FLAGS = ["deleted", "deletedAt", "archived", "isArchived", "archivedAt", "hidden", "status"];
  const flagsOf = (item) => Object.fromEntries(FLAGS.filter((f) => f in item).map((f) => [f, item[f]]));

  const payload = await get(`/api/v3/w/${ws}/tables`);
  const tables = Array.isArray(payload) ? payload : payload?.tables || payload?.items || [];
  console.log(`tables: ${tables.length}; keys on the first:`, Object.keys(tables[0] || {}));
  console.table(tables.map((t) => ({ id: t.id, label: t.label, ...flagsOf(t) })));

  const first = tables[0];
  if (!first) return;
  const meta = await get(`/api/v3/w/${ws}/tables/${first.id}`);
  const cols = meta?.columns || meta?.fields || [];
  console.log(`columns on ${first.label || first.id}: ${cols.length}; keys on the first:`, Object.keys(cols[0] || {}));
  console.table(cols.map((c) => ({ name: c.name, label: c.label, ...flagsOf(c) })));
})();
