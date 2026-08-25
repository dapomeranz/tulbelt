# Handoff — finish the Paste Trigger Anywhere investigation in a browser

You are picking up an investigation that has gone as far as it can without a
browser. Everything already learned is in
[paste-trigger-anywhere.md](./paste-trigger-anywhere.md) — read it first; it is
the authority and this file only tells you what to **do**.

Repo: `thedjcdarren/tulbelt`, branch `claude/magical-mayer-ub5m6z`.
Probes live in [`probes/`](./probes/).

## The one question

Tulip refuses to paste a trigger onto a different **surface** (app-level ↔
step-level ↔ component ↔ a different custom widget type). We know why, we know
the payload format, and we know a rewritten payload enters Tulip's own paste
path correctly. What is unknown:

> **Does Tulip's paste API accept a trigger whose binding has been rewritten to
> a different surface — when the record and the target are consistent?**

If yes, the toggle gets built. If no, the feature is dead and we say so. Nothing
else in this investigation matters until that is answered.

## What you need before starting

1. **A Tulip instance and a login.** Ask the user; never commit the hostname.
2. **A scratch app** — create a new app, or a new version of a throwaway one.
   **A successful paste creates a real trigger on the server.** Do not
   experiment in anything anyone depends on.
3. **Chrome with a real profile.** The editor is a heavy React/Meteor app;
   drive it headed if you can. Grant clipboard permissions:
   `context.grantPermissions(['clipboard-read', 'clipboard-write'])`.
4. In the scratch app, create by hand: a step with **one trigger in each list**
   (On step enter, On step exit, Timers, Machines & devices), an **app-level**
   trigger, a **button** with a trigger, and — if the instance has custom
   widgets — **two different custom widget types**, each with a trigger.
   Everything below is copying those around.

If login is SSO and resists automation, stop and tell the user rather than
burning hours on it — they can drive the browser and paste results back, which
is how every finding so far was collected.

## Ground rules

- **Never commit tenant data.** No instance hostname, no app/step/widget/trigger
  ids, no user ids — not in docs, commit messages, or code. The probes redact
  the hostname; ids they do not. Findings go in the doc as _shapes_, not values.
- **Scratch app only.** Every accepted paste writes to the server.
- Probes are throwaway. If you change one, keep it working for a human at a
  console — that is how the user runs them.

## Background in 30 seconds

- Copy writes `<span data-tulip-clipboard="<base64 JSON>">` to the clipboard as
  `text/html`.
- The payload is `{ isTulipAppClipboardContent, sourceCustomer, sourceStepId,
  sourceAppId, …, clipboardType: "Trigger", trigger: {…}, variables, queryIds,
  recordPlaceholders }`.
- Paste parses that, then **branches on the trigger's own ids** — not on
  `event.type`:

  | Branch | Chosen when                     | Target sent to the API                   |
  | ------ | ------------------------------- | ---------------------------------------- |
  | app    | no `stepId`, no `widgetId`      | `{ type: Process }`                      |
  | step   | `stepId` set, no `widgetId`     | `{ type: Step, stepId: <current step> }`  |
  | widget | `widgetId` set                  | `{ type: Widget, widgetId: <selected> }`  |

- The paste itself is `POST /api/apps/v1/w/<ws>/app-versions/<id>/paste`. The
  **server** creates the trigger and returns `triggerIds`.
- A previous attempt rewrote only `event.type` and got **422** — because the
  record still classified as a step trigger while carrying a widget event. The
  pair must move together.

## The experiment

`probes/paste-rewrite-test.js` does all of it. In Playwright, inject with
`page.evaluate(fs.readFileSync('docs/probes/paste-rewrite-test.js', 'utf8'))`
and drive its API the same way. It captures the payload from a copy click (via
a `Clipboard.write` hook, so no clipboard reads and no focus problems), rewrites
the binding, dispatches a synthetic paste, and reports the verdict from the
paste API's status and body.

Per attempt:

1. `__pasteTest.arm()`
2. Click the copy icon on the source trigger's row (Playwright click).
3. `__pasteTest.show()` — confirms what was captured and how it will classify.
4. Put the editor in the destination state (open the destination step; click the
   destination widget on the canvas if the target is a component).
5. `await __pasteTest.tryAs(<type>, <options>)` — returns one of
   `ACCEPTED` / `REFUSED by the server — status … — <body>` / `NO API CALL` /
   `IGNORED`.

### The matrix

Run every row. Record the verdict and, for refusals, **the full response body**.

| # | Source trigger      | Call                                                                  | Destination state       |
| - | ------------------- | --------------------------------------------------------------------- | ----------------------- |
| 1 | On step enter       | `tryAs('button-press', { widgetId: '<target button>' })`               | that button selected    |
| 2 | Button              | `tryAs('step-open', { stepId: '<current step>' })`                     | that step open          |
| 3 | Button              | `tryAs('app-start')`                                                   | anywhere in the app     |
| 4 | On step enter       | `tryAs('app-start')`                                                   | anywhere                |
| 5 | App started         | `tryAs('step-open', { stepId: '<current step>' })`                     | that step open          |
| 6 | On step enter       | `tryAs('interval', { stepId: '<current step>', args: { interval: 30 } })` | that step open       |
| 7 | Timer               | `tryAs('step-closed', { stepId: '<current step>' })`                   | that step open          |
| 8 | Custom widget A     | `tryAs('custom-widget-event', { widgetId: '<B>', eventName: '<B event>', customWidgetId: '<B type>' })` | widget B selected |

Row 3 is the cleanest signal — it needs no ids from you at all (app class nulls
both). **If rows 1–3 come back ACCEPTED the feature is real.** Row 8 is the
custom-widget case the user specifically wants; its ids come from copying an
existing trigger off widget B and reading `__pasteTest.show()`.

### Getting the ids you need

`widgetId`, `stepId`, `eventName` and `customWidgetId` all appear in the payload
of any trigger already living on that target — `__pasteTest.arm()`, click that
trigger's copy icon, read `show()`. `probes/trigger-harvest.js` does the same in
bulk for a whole trigger list.

### After an ACCEPTED

Confirm it is real, not just a 200:

- Does the trigger editor open, and does the trigger appear in the destination
  list after closing it?
- Do its actions survive intact?
- **Reload the page** — is it still there? (Proves the server kept it.)
- Open the app in the Player if that is quick: does the trigger actually fire on
  the destination's event?

A 200 that produces a trigger which vanishes on reload, or never fires, is a
_negative_ result and must be reported as one.

### If everything is REFUSED

Capture the 422/400 body verbatim — it names the field that failed and that is
the most useful thing you can bring back. Then try, in order: leaving
`event.id` as-is vs. removing it; leaving the source `stepId` on an app-class
rewrite; sending `clipboardType` untouched. Each is one line in `rewrite()` in
the test probe.

## Also worth collecting while you are in there

Only after the main question is answered:

1. **`await __grep(["triggerToPaste"], 2500)`** (`probes/bundle-grep.js`) — the
   one unread validation branch, between the widgets-in-step test and the
   `customWidgetId` comparison. Expected to be "a non-custom-widget event may
   not land on a custom widget".
2. **DOM dumps of every trigger list** — `probes/trigger-clipboard-probe.js`
   has `__tpaPane(label)`. Needed to know where to inject the **Paste trigger**
   buttons: the app-level list, the four step lists, and a custom widget's event
   sections. Capture enough structure to write a stable selector, plus how each
   section identifies itself (heading text is currently the only known key).

## What to report back

Update [paste-trigger-anywhere.md](./paste-trigger-anywhere.md) — a new section
with the matrix and its verdicts, and correct anything the results contradict.
The doc is the deliverable; the branch is where it lives. Commit to
`claude/magical-mayer-ub5m6z`.

Then say plainly, in one line: **does the paste API accept a consistent
cross-surface rewrite, yes or no** — and if yes, which of the eight rows worked
and which did not. That sentence is the whole point of the trip.
