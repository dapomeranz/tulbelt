# Getting a list of table names and ids

Research note for the Data Queries query builder (`toggles/data-queries.js`),
which today asks the user to paste a table id. This is where the list of
`{ id, name }` pairs should come from.

## The answer

`GET /api/v3/w/<wsId>/tables` — the documented list endpoint, the collection
sibling of the two calls Data Queries already makes.

```
GET /api/v3/w/<wsId>/tables
→ [ { id, label, description, columns: [ { name, label, dataType, hidden, unique } ], createdAt, … } ]
```

> **Corrected 2026-08-27, from running it.** This note originally said `limit`
> is 1–100 and `offset` pages. That is wrong. The endpoint accepts **no query
> string at all** — `?limit=100&offset=0` returns
> `400 InvalidQueryString: "Unable to parse query string: extra param(s): limit,
offset"`. It is unpaged: one call returns the workspace's tables.
>
> That same 400 settled the open question below. A 400 is the endpoint parsing
> our request and rejecting the params; a refusal of the borrowed session
> credential would have been a 401 or 403. **The session credential works on the
> collection endpoint.**

- `includeDeleted` defaults to false, which is what we want.
- The workspace can travel as an `X-Tulip-Workspace-ID` header instead of the
  `/w/<id>` path segment; the header wins if both are present. The path form
  matches what `apiJson()` already builds, so there's no reason to switch.

Two things fall out of this beyond the picker:

**`columns` comes back with each table.** That is the same metadata
`fetchTableMeta()` fetches per-table today for column labels. One list call
could seed the column metadata for every table at once, and the per-table
metadata round-trip on each Load could go away.

**Saved queries could show a name.** `data-queries.js:577` renders saved queries
as `` `${q.tableId} · ${count} filters` ``. With an id→name map in hand that
line reads as "Work Orders · 2 filters" instead of a random id.

## The open question — settled, and the one that replaced it

Docs describe `/tables` in terms of an API token carrying the `tables:read`
scope. Data Queries has no API token — it borrows the `Authorization: Basic …`
header Tulip's own frontend sends (`toggles/tulbelt-session-main.js`). Whether
that session credential is accepted on the _collection_ endpoint is not
something the docs answer.

The precedent is encouraging: `toggles/submitted-pending-approvals.js:117`
already pages `/api/apps/v1/w/<ws>/apps?offset=&limit=&sort=name` with this same
borrowed header, in production, today. A collection endpoint is not off-limits
to the session credential in general.

`docs/probes/table-list-probe.js` settles it for tables specifically. Paste it
into the DevTools console of any `*.tulip.co` tab (page/"top" context) and run
`await __tableProbe()`. It tries six candidate paths — the documented one, the
no-params and header-workspace variants, the `apps`-style paging params, and a
speculative `/api/tables/v1/…` namespace in case tables have since moved off
flat `/api/v3/` the way apps did — and reports for each the status, whether the
sniffed header or the cookie retry is what worked, and the actual response
shape: which key holds the id, which holds the name, whether `columns` rode
along. Table names are masked unless you pass `{ reveal: true }`.

If every candidate is refused, `__tableProbe.sniff()` is the fallback. Load the
tenant's own Tables list page first, then run it: it prints the distinct `/api/`
paths the tab has already fetched, with ids collapsed. Tulip's Tables page has
to get this data from somewhere, and whatever it calls is by definition
reachable with the credentials the session already has.

## Enumerating workspaces

`/tables` is scoped to one workspace by its `/w/<id>/` path segment, and the
picker should span every workspace the account can reach. Nothing in Tulbelt
knows which those are: `tulbelt-session-main.js` sniffs exactly one numeric id
off the first API call it sees, and the browser URL carries a slug
(`/w/DEFAULT/`), not a number.

`docs/probes/workspace-list-probe.js` settles it, the same way. It runs two
independent parts: candidate workspace-list endpoints (the good outcome — real
workspace _names_), and a direct scan of `/api/v3/w/N/tables` for N = 1..20,
which cannot really fail because it uses only the call we now know works. The
scan answers "which workspace ids does this account reach" with no list endpoint
at all; it just can't supply names.

**The correctness trap.** `fetchRecords()` and `fetchTableMeta()` build their
URLs from the single ambient `workspaceId()`. A table listed from workspace 3
and picked would have its records fetched from `/w/1/…` and 404. Spanning
workspaces therefore requires each table to carry its own `wsId`, those two
calls to take it as an argument, and saved queries to record it — an optional
field, so queries saved before it (and imports from other users) keep working by
falling back to the ambient workspace.

## Fallbacks, if the endpoint is refused

Ranked by how much they actually give you.

**1. The history-search MRU.** `toggles/history-search.js` already stores
`{ kind, id, name, folder, root, url, ts }` per visited entity under
`chrome.storage.local["tulbelt:history"]`, capped at 100 and MRU-ordered.
Filtering `kind === "table"` yields exactly the id+name pairs the picker wants,
with a genuinely useful ordering (most recently opened first) and no network
call at all. `history-search.js` loads into the same isolated world as
`data-queries.js` (`manifest.json:44`), so the key is readable with no new
plumbing.

The catch: it holds only tables this user opened in this browser profile while
the toggle was on. It is a recents list, not an enumeration — good as a
zero-cost head of the list, not as the list.

**2. DOM scrape of the app editor's Tables tile.** `collapse-tables-tile.js:218`
enumerates table rows by anchoring on `button[id^="add-query-"]`, taking the
name from `:scope > [aria-haspopup="menu"]` (line 231). It is the one place in
the repo where a table name and a per-table id token sit adjacent in the DOM —
worth checking whether that `add-query-<token>` id is the real table id. Scoped
to tables bound to the open app, and only on app editor pages, so it can't serve
the Tulbelt page directly.

**3. Scraping the `/tables` list page.** Not attempted, and `flatten-top-menu.js`
records the reason to be wary: dispatched pointer events do not open Tulip's
production dropdowns, so anything requiring synthetic hover is a dead end. A
real page's rendered rows are fine; a picker popper is not.

## Implementation sketch

The fetch layer needs one function beside the existing two:

```js
function fetchTables(limit = 100, offset = 0) {
  return apiJson(`/api/v3/w/${workspaceId()}/tables?limit=${limit}&offset=${offset}`);
}
```

It inherits the header-then-cookie retry for free. Page until a response comes
back short of `limit`, matching how `submitted-pending-approvals.js` walks
`/apps`.

The UI slot is `renderBuilder()`, lines 426–451: `tableInput` (a bare text field
whose `input` handler writes `state.query.tableId` without re-rendering, to keep
the caret) plus the "Load table" button. The smallest change that keeps every
existing path working is to leave the input as-is and back it with a `datalist`
of `<option value=<id> label=<name>>` — paste still works, `parseTableId()` at
lines 184–190 still normalises a pasted URL, and the picker is additive. A
`query-list-search.js`-style filtered dropdown is the richer version if the
list turns out to be long.

Load the list lazily on first mount of the tab, cache it on `state`, and fold
the history-search recents in at the top of the list regardless of whether the
API call lands — that way a refused endpoint degrades to a useful recents
picker rather than to nothing.
