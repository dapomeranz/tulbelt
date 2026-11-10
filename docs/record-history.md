# Record History tab

Design note for `toggles/record-history.js` and its MAIN-world half,
`toggles/record-history-main.js`.

## Where the data comes from

Tulip's Record History widget (internally "DHR") does not use the table REST
API. Reading the shipped bundle, its data hook is one Meteor method call:

```js
Meteor.call("getHistoryRecord", {
  ddmId,                 // table id
  ddmRecordId,           // record id, matched exactly
  minDate, maxDate,      // optional window; maxDate doubles as the paging cursor
  filters,               // the widget's filter rows; [] for none
  hideProcessData,       // boolean
  signedCompletionsOnly, // boolean
  isExport,              // true = don't slice, return everything (used for print)
})
// → { historyRecord: [eventGroup], isLimited, minDate }
```

The bundle's route table also names `GET /api/v3/w/<ws>/tables/<id>/history`,
but nothing in the client calls it, so its parameters and response are unknown.
The tab uses the method, which is what the widget itself is proven to use.

Meteor exists only in the page's JS world, so the isolated script sends a
`tulbelt:rh-request` event and the MAIN script answers with
`tulbelt:rh-response` (JSON strings both ways). The MAIN script finds Meteor at
`window.Meteor` or `window.Package.meteor.Meteor`.

**Paging.** When `isLimited` is true the history was cut off at `minDate`; the
widget's "Load more data" repeats the call with that value as `maxDate`. The
value is whatever EJSON delivered (a Date, most likely), which JSON would turn
into a string, so the MAIN script keeps the raw value under a token and the
isolated script passes the token back. Older slices are prepended, and a seam
that falls inside one app run or one step is stitched the way the widget does.

## The shape drawn

`historyRecord` is ascending by time. Each element is an event group:

| `context`                                 | Carries                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `app`                                     | `hydratedActor`, `appName`, `versionName`, `stationName`, `steps[]`                                       |
| `admin`, `api`, `automation`, `unknown`   | `hydratedActor`, `possiblyCorrupted`, and the event's own fields (`kind`, `date`, `items`) on the group   |
| `ai-agent`                                | the same, plus `actorType` and `aiContext { agentName, aiSessionId }`                                     |

A step is `{ stepName, startTime, isContinued, isCanceled, events[] }`. An event
is `{ kind, date, formName?, items[] }` with `kind` one of `create`, `update`,
`delete`, `truncate`, `form`, `signature`, `variables`, or `eSig` (which carries
`eSigInfo` instead of items). An item is
`{ label, dataType, value, previousValue, hidden }` — `hidden` marks an archived
column.

`possiblyCorrupted` groups are attributed to "A Service Account", as in the
widget. Values are formatted by shape rather than by Tulip's full type
renderer: timestamps in local time (raw value on hover), URLs as links, arrays
as lists, anything else structured as JSON. A `user`-typed value therefore shows
the user id, not the name.

## Workspaces

`getHistoryRecord` has no workspace argument: the server keeps a current
workspace per DDP connection (`setCurrentWorkspaceID`) and the method runs in
it. So the tab works in the workspace the browser tab is in and offers no
workspace picker — tables and records are read from that workspace's REST
paths (`/api/v3/w/<ws>/…`), and the history call lands in the same one. Reading
another workspace means switching Tulip to it first. Calling
`setCurrentWorkspaceID` ourselves is not an option: its client stub re-points
the whole Tulip app running under the panel.

## Whether the instance has history at all

The widget's definition is hidden unless a plan feature is on:

```js
isHidden: () => !select(getTableAuditLogEnabled)   // feature "tableAuditLog"
```

A boolean plan feature is on when an override sets it true **or** the plan's
default is true. In the bundle's plan table only `regulated` has
`tableAuditLog: true`; every other plan needs an override. The plan document
and the overrides are in the client collections `Plans` (first document's
`type`, defaulting to `enterprise`) and `PlanOverrides` (`{ name, value }`),
delivered by the `pricing_plans` subscription.

The MAIN script subscribes to `pricing_plans`, reads both collections off
`Meteor.connection._mongo_livedata_collections`, and applies that rule. It
answers `known: false` when nobody is signed in or the plan hasn't arrived, and
the isolated script retries (2s, 5s, 15s, then every minute). Only a `known`
answer exposes or hides anything, and a yes is cached per host in
`chrome.storage.local["tulbelt:record-history-available"]` as a head start for
the next page load. The subscription is stopped when the toggle goes off.

The list of plans that include the feature (`PLANS_WITH_HISTORY`) is copied
from the bundle. If Tulip adds the feature to another plan's defaults, an
instance on that plan would be wrongly hidden until the list is updated.

## Not yet verified against a live instance

This was built from the bundle, without a signed-in session to run it in.
Things to confirm on first use:

- `getHistoryRecord` answers from a non-player page (the method may expect a
  player context) and for an account that isn't running the app.
- The availability check: that `pricing_plans` delivers `Plans` and
  `PlanOverrides` to an ordinary signed-in user, and that an instance you know
  has the widget comes out `enabled`. If the tab never appears on such an
  instance, this is the first thing to look at.
- The record search: `contains` filters on `id` and on each `string` column
  with `filterAggregator=any`. If Tulip rejects the wide query with a 400 the
  tab retries on `id` alone, so the list still works but stops matching other
  columns.
