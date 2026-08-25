# Stress test — every source against every destination

For an agent driving real Chrome against a real Tulip instance. Every bug found
in this feature so far lived in a *specific* source/destination pair and was
found by a user hitting it. This is the sweep that should find the rest first.

**Last run: 75/75 cells passed** — every destination against one source of every
class, all `201`, correct `When` throughout, no refusals. Re-run this after any
change to the rewrite or to how a destination is resolved.

Background: [paste-trigger-anywhere.md](./paste-trigger-anywhere.md).
Harness: [`probes/paste-stress.js`](./probes/paste-stress.js).
Repo: `thedjcdarren/tulbelt`, branch `claude/magical-mayer-ub5m6z`.

## Read this before anything else

- **Every accepted paste creates a real trigger on the server**, at paste time,
  with no save to confirm it. A full run makes dozens. **Create a throwaway app
  version for this and delete the version afterwards** — that is one action
  instead of dozens.
- **Check the loaded build.** Pull the branch, reload the extension, reload the
  tab. If `window.__ptaDebug = true` produces no `[tulbelt:pta]` lines when you
  click a paste icon, you are on a stale build and the run is worthless.
- **No instance data in the repo.** Ids and hostname go in chat only.
- **Report refusals, don't route around them.** A refusal that is understood is
  a result; a pass that was retried into existence is not.

## What is actually being tested

The rewrite depends on the **destination** (which class, which event) and on
almost nothing about the source — its clauses ride along untouched, its event
and ids are overwritten. So a full N×N sweep would mostly re-test the same
code path. The matrix that matters is:

**every destination × one source from each class.** Sources:

| Source class | Use                                      | Why |
| ------------ | ---------------------------------------- | --- |
| App          | an App started trigger                   | no ids in the record at all |
| Step         | an On step enter trigger                 | `stepId`, no `widgetId` |
| Step + args  | a **Timer** trigger                      | carries `event.args`, which must not leak into other destinations |
| Widget       | a **button** trigger                     | both ids; the common real-world case |
| Custom widget| a trigger on custom widget **A**         | carries `eventName` + `customWidgetId` of a *specific* widget type |

Give each source a **distinct, identifiable action** — a Show Message with the
source's name in the text. That makes "did the actions survive" answerable by
looking, and tells you which source a stray trigger came from later.

Destinations: **every paste icon that exists**. App started / Completed /
Cancelled; a step's On step enter / On step exit / Timers / Machines & devices;
a button's panel-level icon; a text input's On enter press and On input exit;
an interactive table; every event section of custom widget A **and** of a
*different* custom widget B.

That is roughly 5 × 13 ≈ 65 pastes. The harness does them unattended.

## Expected result per destination

The **When** the editor shows after the paste is the assertion — it says where
the trigger actually landed. Observed so far:

| Destination        | Expected When            |
| ------------------ | ------------------------ |
| App started        | app is started           |
| App completed      | (record it)              |
| App cancelled      | (record it)              |
| On step enter      | step is opened           |
| On step exit       | step is closed           |
| Timers             | timer fires              |
| Machines & devices | a device output          |
| Button panel       | button is pressed        |
| On enter press     | enter key is pressed     |
| On input exit      | input is exited          |
| Interactive table  | a row is selected        |
| Custom widget §    | Custom Widget event occurs — **and it must land in the section whose icon you clicked** |

Two known-good behaviours, not bugs, so don't report them as such:

- The **When dropdown lists events from other widget types**. Tulip's own
  Ctrl+V paste does the same; it is not ours.
- A **single-event component** (button, interactive table) names no event type
  and carries no label. It lands on a generic widget event and Tulip re-derives
  the right one. Correct by that route.

**Machines & devices** is the one destination whose paste is deliberately
incomplete: it arrives with the device pickers **unset** for the user to choose.
Check three things there — that the paste is accepted at all (empty-string args
have never been through the server), that the editor lets you pick a driver and
device output, and that switching the When to a machine works from the same
editor. It should not refuse, and it should not arrive pointing at some other
trigger's device.

## Procedure

1. Build the scratch version: a step with a trigger in each of its four lists,
   an app-level trigger, a button with a trigger, a text input with a trigger in
   **each** of its two sections, an interactive table, and two **different**
   custom widget types each with a trigger. Distinct Show Message text in each.
2. Paste [`probes/paste-stress.js`](./probes/paste-stress.js) into the console
   (page context). `__stress.help()` prints the sequence.
3. **Collect sources.** On each surface in turn:
   `__stress.captureHere('app')`, `__stress.captureHere('step')`,
   `__stress.captureHere('button')`, `__stress.captureHere('cwA')`. Check with
   `__stress.sources()` — you want five, each showing a different event.
   The cache lives in sessionStorage, so switching panels does not lose it.
4. **Run each destination panel.** Navigate to a panel, confirm
   `__stress.destinations()` lists what you expect, then `await __stress.run()`.
   Repeat for the app tab, the step tab, and each widget's panel.
5. `copy(__stress.report())` and paste it back.

Trim a run with `__stress.run({ sourceFilter: 'button' })` or
`{ destinationFilter: 'Timers' }` when chasing one cell.

## What to report

The harness prints one line per cell: source → destination, API status, the When
that resulted, and any refusal message. Send the whole report, plus:

1. **Every cell whose When doesn't match the table above** — that is the
   headline result. Include what it was instead.
2. **Any custom widget paste that landed in the wrong section** of the right
   widget. That is the `eventName` path failing and it will be silent otherwise.
3. **Any Timer or Machines & devices `args` appearing on a destination that
   shouldn't have them**, or missing where they should.
4. **Whether actions survived** — spot-check three pasted triggers from
   different sources and confirm the Show Message text is the source's.
5. Anything that produced **no API call at all** — that is the codec refusing
   the payload before the request, and the console will have Tulip's
   "not valid AppClipboardContent" line.

Then say plainly: which cells work, which don't, and whether any of the failures
share a cause.

## If the harness misbehaves

- `no trigger rows with a copy button here` — the copy icon appears on row
  hover; the selector may not match this instance. Report the row markup.
- `no paste buttons on screen` — the toggle is off, developer mode is off, or
  the build is stale.
- Editor not closing between cells — the harness sends Escape and looks for a
  Close/Cancel button. If a modal stays open, results after it are unreliable;
  say so and raise `settleMs`.
- Nothing persists between panels — sessionStorage was cleared by a full
  navigation. Re-capture the sources.
