# Paste Trigger Anywhere — research notes and design

Working notes for a planned toggle that lets a copied trigger be pasted onto an
owner Tulip currently refuses.

Status: **shipped, off by default.** The mechanism is proven end to end against
a live instance: cross-surface pastes return `201`, land in their destination
lists, keep their actions, survive a hard reload — and **a moved trigger
fires**, confirmed in the Player for a button trigger moved to App started and
another moved to Timers.

A full sweep then ran **every destination against one source of every class —
75 cells — and all 75 passed**: correct `When` everywhere, no refusals, no
missing API calls. See [The stress run](#the-stress-run).

The sections below are the investigation in the order it happened, so earlier
ones describe models that later ones correct. Where they disagree,
[The shape that works](#the-shape-that-works) is right.

## The actual gap

**Component-to-component already works.** A trigger copied from a button pastes
onto an input field or an interactive table today, even though those are
different widget types. So widget triggers are _not_ what needs fixing, and the
guard is not per-widget-type.

What is refused is crossing between the trigger **surfaces**:

| Surface           | Events                                                                        |
| ----------------- | ----------------------------------------------------------------------------- |
| App level         | App started · App completed · App cancelled                                    |
| Step level        | On step enter · On step exit · Timers · Machines & devices                     |
| Component (widget) | button press, input change, table row select, … — interchangeable already      |
| Custom widget     | events **declared by that widget's own code** — not interchangeable, even between two custom widgets |

The wanted moves are: any app-level event ↔ any other app-level event, app ↔
step, step ↔ step, either of those ↔ a component, and one custom widget type →
a different custom widget type.

**Paste needs somewhere to land.** Today paste is Ctrl/Cmd+V against the
_selected widget_ — which is why component-to-component works at all. App-level
and step-level trigger lists have no canvas selection to aim at, so there is
nothing to press Ctrl+V "on". The feature therefore needs an explicit **Paste
trigger** affordance in each of those trigger lists (App started, App completed,
App cancelled, On step enter, On step exit, Timers, Machines & devices, and each
custom widget event section) so the destination is picked by pointing at it. The
button is not decoration — it is how the target is named.

## What the surface split is protecting

A trigger is `When` / `If` / `Then`. The `If` (conditions) and `Then` (actions
and transitions) are owner-agnostic — that is exactly why builders want to move
them. The `When` is bound to its surface: a step's `on step enter` means nothing
to an app-level list, and a custom widget's declared event means nothing to a
different custom widget. Tulip's guard exists so a trigger can never end up with
a `When` its owner cannot produce.

That is a real constraint, and the toggle should not pretend otherwise: the
goal is to let the paste **happen** and land the user in the trigger editor
with the logic intact, leaving any `When` that could not be carried over — and
any action that referenced the old owner — visible and unset for them to fix
before saving. A trigger that pastes cleanly and one that pastes with a hole in
it should both be better than retyping fifteen actions.

## Confirmed by probe

One session on a live instance, copying a button trigger and pasting it onto
several targets — some accepted, one refused:

**Copy goes to the real system clipboard**, via
`navigator.clipboard.write()` — a `ClipboardItem`, not `writeText`. It fires
from a click on the trigger row's copy button, inside the user gesture. So the
payload is serialized and shared: this is why paste works across apps, and it
is a payload Tulbelt can see and rewrite.

**Paste is a trusted `paste` event**, not a clipboard read. At capture phase
the event arrives with `defaultPrevented: false`; Tulip's own handler runs; by
the time it bubbles back to `window` it is `defaultPrevented: true`. Tulip
reads the payload out of `event.clipboardData` in between.

**The guard is client-side, between reading the payload and opening the
editor.** Tulip's own clientLogger brackets the paste with two lines:

```
[Copy/Paste]: Pasting trigger in app editor
    { sourceAppId, sourceStepId, targetAppId, targetStepId }
[Copy/Paste]: Pasting trigger, opening trigger editor
    { oldAppVersionId, oldTriggerId, newAppVersionId, newTriggerId }
```

Both context objects are worth reading closely:

- **The destination comes from editor state, not the payload.** Tulip has a
  `targetStepId` before it has decided anything, and there is no widget id in
  that context at all — source or target. So the handler locates where the user
  is (app + step) and takes the widget from canvas selection separately. That is
  precisely what the injected paste buttons have to supply for surfaces where
  there is no selection to read.
- **The trigger is re-IDed on paste** — `newTriggerId` differs from
  `oldTriggerId`. So the payload's `id`, and presumably `versionSetId` /
  `importFamilyId` / `created` / `lastModified`, are Tulip's to regenerate. The
  rewrite should leave all of them alone and touch only the binding.

Every paste in the run logged the first line — **including the refused one**,
which proves the payload is read and parsed before the compatibility check.
Only the refused paste never logged the second. (Its Ctrl+V also differed in
one visible way: the editor had a different set of context-pane testids on
screen, consistent with a different surface being open rather than a canvas
widget being selected.) Nothing was written to `localStorage` (the only writes
were `tulip-last-activity` and feature-flag chatter), no `readText`/`read` call
was made, and no warning or error was logged on refusal — it fails silently.

### The payload

It rides on the **`text/html`** flavor of the clipboard, not `text/plain`: a
single empty `<span>` whose `data-tulip-clipboard` attribute holds base64 of a
JSON envelope. (So a trigger copied to a text editor looks like nothing at all —
there is no visible text.)

```
<meta charset='utf-8'><html><head></head><body>
  <span data-tulip-clipboard="<base64 of the JSON below>"></span>
</body></html>
```

Decoded, with values replaced by their kind:

```jsonc
{
  "isTulipAppClipboardContent": true,   // positive identification — match on this
  "clipboardType": "Trigger",           // widgets and steps presumably use other values
  "sourceStepId": "<stepId>",
  "sourceAppVersionId": "<appVersionId>",
  "sourceAppId": "<appId>",
  "sourceCustomer": "<instance hostname>",
  "sourceWorkspaceId": "<workspaceId>",
  "trigger": {
    "id": "<triggerId>",
    "name": "Example Trig",
    "versionSetId": "<id>",
    "importFamilyId": "<id>",
    "appVersionId": "<appVersionId>",
    "stepId": "<stepId>",              // owning step
    "widgetId": "<widgetId>",          // owning widget — absent for step/app triggers?
    "disabled": false,
    "workspaces": { "scope": "specific", "workspaceIds": ["<workspaceId>"] },
    "created": { "at": "<iso>", "by": { "type": "user", "id": "<userId>" } },
    "lastModified": { "at": "<iso>", "by": { "type": "user", "id": "<userId>" } },
    "clauses": [                       // the If / Then — owner-agnostic
      {
        "id": "<id>",
        "type": "and",
        "conditions": [],
        "actions": [
          {
            "id": "<id>",
            "type": "show-message",
            "inputs": [ { "datasourceType": "static", "schema": { "type": "string" },
                          "permissions": { "isReadable": true, "isWritable": false },
                          "params": { "value": "Hi" } } ],
            "isTransition": false
          }
        ]
      }
    ],
    "event": { "id": "<id>", "type": "button-press" }   // ← the owner binding
  },
  "queryIds": [],                      // dependencies carried along with the trigger
  "variables": [],
  "recordPlaceholders": []
}
```

Three things follow immediately.

**The owner binding is `trigger.event`, plus `stepId` / `widgetId`.** The
payload carries no widget _type_ field at all — only ids, and ids cannot be
resolved when pasting into a different app (a documented, working case). So the
paste handler has nothing to route on but `event.type` and which of
`stepId`/`widgetId` are set.

**Tulip already rewrites the binding on a widget paste.** A `button-press`
trigger lands happily on an interactive table, which does not fire
`button-press` — so the existing paste path re-homes both the ids and the event
to whatever the selected widget is. That is encouraging: the machinery to
re-bind a trigger exists in Tulip's own code and works. The refusal is about
which surfaces the paste path is willing to route _between_, not about the
trigger record being unportable.

**`clauses` is the part worth moving, and it is already owner-agnostic** —
conditions and actions, with no back-reference to the widget. Which is why a
rewrite is plausible at all: change the binding, keep the clauses.

### The event vocabulary

Harvested from a live app (27 triggers across the app- and step-level lists):

| Trigger list        | `event.type`    | `event.args`                          | `stepId` | `widgetId` |
| ------------------- | --------------- | ------------------------------------- | -------- | ---------- |
| App started         | `app-start`     | —                                     | null     | null       |
| App completed       | `app-complete`  | —                                     | null     | null       |
| App cancelled       | `app-cancel`    | —                                     | null     | null       |
| On step enter       | `step-open`     | —                                     | set      | null       |
| On step exit        | `step-closed`   | —                                     | set      | null       |
| Timers              | `interval`      | `{ interval: 30 }`                    | set      | null       |
| Machines & devices  | `device-output` | `{ driver, event }`                   | set      | null       |
| Component (button)  | `button-press`  | —                                     | set      | set        |
| Custom widget       | `custom-widget-event` | — (see below)                   | set      | set        |

The custom widget event is the only one that names anything outside itself:

```jsonc
"event": {
  "id": "<slot id>",
  "type": "custom-widget-event",
  "eventName": "<id of an event this widget type declares>",
  "customWidgetId": "<the custom widget TYPE id>"
}
```

**One record shape, three binding levels.** App-level triggers have neither
`stepId` nor `widgetId`; step-level triggers have `stepId`; component triggers
have both. Nothing else about the record changes between surfaces — which
settles strategy A over B: patch the binding, keep everything else.

**`event.id` is the slot, not the trigger.** Two triggers sitting in the same
list share one `event.id` — a trigger and its copy both carry the same id for
that step's step-open. So the id identifies the event
_slot_ on that step, not the individual trigger, and a rewrite must use the
**target slot's** id rather than inventing one. Where to get it: any existing
trigger in the destination list already carries it, and that is exactly what an
injected paste button can read from its own section. (Unless Tulip re-derives
`event` from the destination anyway, as it appears to for components — the
bundle grep should say.)

**Two lists need `args`.** Pasting into Timers means supplying
`{ interval: <seconds> }`, and into Machines & devices `{ driver, event }`. A
trigger arriving from any other surface has neither. Both are editable in the
trigger editor that opens, so the button can seed a plausible default (or leave
it empty) and let the user set it before saving — but it must be deliberate,
not omitted by accident.

### Inside Tulip's code

A grep of the editor bundles for the clipboard strings landed on the module
itself. Four things it settles:

**The event taxonomy is formal, and it has four classes.** `TriggerEventTypes`
is a real enum, and the code derives one codec per class from it:

| Class      | Event types                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| **Widget** | `button-press`, `custom-widget-event`, `input-change`, `input-exit`, `enter-press`, `row-select`, `signature-complete` (+ the form pair) |
| **Step**   | `device-output`, `step-closed`, `step-open`, `interval`, `machine-output`                                         |
| **App**    | `app-cancel`, `app-complete`, `app-start`                                                                         |
| **Form**   | `form-submit`, `form-cancel`                                                                                      |

That is the line the feature is trying to cross, and it is drawn in Tulip's own
type definitions. It also explains component-to-component cleanly: every
component event is in one class, so moving between them never leaves it.

Two event types carry extra fields, and the codecs spell out exactly what. Note
the combinators: the bundle uses one helper for **intersection** and a different
one for **union** — `device-output`'s args are an intersection, so `driver` and
`event` are both **required** and `machine` is the only optional part. (Reading
that as a union is what made the first Machines & devices attempt send `{}` and
get rejected by the codec before any request.)

```
custom-widget-event : { type, id, eventName, customWidgetId }
device-output       : { type, id, args: { driver, event } & { machine? } }
interval            : { type, id, args: { interval … } }
everything else     : { type, id }
```

`machine-output` and the form events are types the harvest never saw — worth
knowing they exist before writing a rewrite that assumes the list is closed.

**The clipboard helpers are a tiny module.** One function serializes JSON to
`<span data-tulip-clipboard="<base64>"></span>`, one parses it back out with
`DOMParser`, one writes it to the clipboard. Copy builds
`{ isTulipAppClipboardContent: true, triggers: [<id>] }` and expands it into the
full payload we decoded.

**Paste is a MIME-keyed dispatch table.** Handlers are registered per clipboard
flavor — images, then `text/html`, then `text/plain`. The `text/html` handler
parses the payload, checks `isTulipAppClipboardContent` is present, and hands it
to the paste dispatcher. So a rewritten `text/html` payload enters Tulip's paste
path at exactly the same door the real one does.

**Paste is server-mediated.** This is the one that matters. The handler's own
error message is _"Paste API call succeeded but returned no trigger IDs"_: the
client sends the payload to an API, **the server creates the trigger**, and the
client then opens the editor on the returned `newTriggerId`. Pasting is not a
client-side construction that gets saved later — the record exists on the server
before the editor opens.

Which means the rewrite has to satisfy the **server**, not just the client. If
the API validates the event against the destination, a client-side patch changes
nothing and the feature dies there. That was listed as the question that could
end this; it is now on the critical path rather than at the end of it. The
compensation: the server doing the work means a payload it accepts produces a
_real_ trigger, not something half-constructed in the browser.

### The paste dispatcher, decompiled

The whole trigger-paste path, read out of the bundle and renamed:

```js
async function pasteTrigger(content, ctx) {
  const { trigger } = content;
  const { app, currentStepNodeId } = ctx;
  log("[Copy/Paste]: Pasting trigger in app editor", { …ids });

  if (isAppTrigger(trigger)) {
    paste({ target: { type: Process } })                       → editAppTrigger
  } else if (isStepTrigger(trigger)) {
    if (currentStepNodeId == null) return fail("No active step to paste to");
    paste({ target: { type: Step, stepId: currentStepNodeId } }) → editStepTrigger
  } else if (isWidgetTrigger(trigger)) {
    if (isFormEvent(trigger.event.type)) return error(pastedFormTriggerError);
    const target = getCurrentWidget();                  // the canvas selection
    if (target == null) return error(pastedWidgetTriggerNoWidgetError);
    const patched = validateAndRemap({ triggerToPaste: trigger, targetWidget: target });
    if (patched == null) return;
    paste({ target: { type: Widget, widgetId: target._id } })   → editWidgetTrigger
  } else {
    log.error("[Copy/paste]: Trigger type not recognized for pasting");
  }
}
```

**The destination is chosen by the copied trigger's own class — not by where
you are.** An app trigger always goes to the app level. A step trigger always
goes to the current step. Only the widget branch consults the canvas selection.
There is no "surface guard" to defeat, because there was never a way to ask for
a different surface: class → destination is hardwired.

That reframes the whole feature. It is not about getting past a check. It is
about **changing the class of the payload before Tulip reads it** — rewrite
`trigger.event.type` from `step-open` to `button-press` and the dispatcher takes
the widget branch and pastes onto the selected widget; rewrite it the other way
and the trigger lands in the current step's list. Each branch then derives its
own target ids from editor context.

That also dissolves the "an empty section carries no ids" problem entirely: a
paste button only has to supply an **event type**, a constant string per list.
It never needs the destination's slot id — Tulip's own branch fills that in.

The widget branch's `validateAndRemap` is where the real checks live, and it
already does the remapping this feature wants:

```js
function validateAndRemap({ triggerToPaste, targetWidget, ctx }) {
  const inStep = ctx.stepContext.getWidgetsInStep({ includeBaseLayoutWidgets: false });
  if (!inStep.some(w => w._id === targetWidget._id)) return error(…);   // not a pasteable target
  … // one further custom-widget check, not yet captured
  if (triggerToPaste.event.customWidgetId !== targetWidget.customWidgetId)
    return error(pastedCustomWidgetEventOntoDifferentCustomWidget);     // ← the custom→custom refusal
  if (targetWidget.type !== WidgetTypes.customWidget
      && triggerToPaste.event.type === CustomWidgetEvent)
    return error(pastedCustomWidgetEventOntoNonCustomWidget);

  const supported = /* the target widget's own event types */;
  if (supported.includes(kindOf(triggerToPaste.event.type))) return triggerToPaste;
  return { ...triggerToPaste,
           event: { ...triggerToPaste.event, type: defaultEventFor(supported[0]) } };
}
```

The last two lines are Tulip **rewriting `event.type` to suit the destination**
whenever the source event doesn't fit — which is exactly why button→table works,
and confirms the rewrite this toggle needs is one Tulip already performs on
itself.

Custom widgets are the one place with genuine, explicit refusals, and both are
just field comparisons: `event.customWidgetId` must equal the target's, and a
`custom-widget-event` may not land on a non-custom widget. Rewriting
`customWidgetId` (and `eventName`) to the destination's satisfies them.

**Two entry-level guards** worth respecting: the payload's `sourceCustomer` must
match the current instance (else `pasteAcrossCustomersError`), and a
cross-workspace paste carrying `queryIds` or `recordPlaceholders` is refused.
The rewrite must leave all of those fields alone.

**Preserve keys we don't understand.** `haltOnError` shows up on app-start,
app-complete, app-cancel, step-open and step-closed triggers but not on
`interval` or `device-output`. The rewrite patches named fields and copies the
rest through untouched, so a field like this survives without us modelling it.

### What the first rewrite attempt proved

Four attempts with
[`probes/paste-rewrite-test.js`](./probes/paste-rewrite-test.js), rewriting only
`trigger.event.type` and dispatching a synthetic paste:

| Attempt                       | Result                                     |
| ----------------------------- | ------------------------------------------ |
| step trigger → `button-press` | dispatcher ran, **paste API returned 422** |
| button trigger → `step-open`  | dispatcher ran, **no API call at all**     |
| button trigger → `app-start`  | dispatcher ran, no API call                |
| button trigger → `interval`   | dispatcher ran, no API call                |

**The synthetic paste works.** Every attempt produced Tulip's own "Pasting
trigger in app editor" line and left the event `defaultPrevented: true`. A
`ClipboardEvent` built in the page enters the dispatcher exactly like a real
one — no trusted event required, and no clipboard write needed either. The
interception approach is sound.

**The dispatcher classifies on `stepId` / `widgetId`, not on `event.type`.**
That is the correction. A step trigger rewritten to `button-press` still took
the **step** branch — it kept `stepId` set and `widgetId` null — and called the
API with `target: { type: Step }` carrying a widget-class event. The server
refused that pairing with **422 Unprocessable Content**, which is what a schema
validator returns when a record and its target disagree. Conversely, a button
trigger rewritten to `step-open` still took the **widget** branch, which needs
`getCurrentWidget()`; with nothing selected it bailed before reaching the API —
exactly the "no API call" result.

So the binding is a **pair**, and both halves have to move together:

| Destination | `stepId`    | `widgetId`    | `event.type` |
| ----------- | ----------- | ------------- | ------------ |
| App level   | null        | null          | app class    |
| Step list   | target step | null          | step class   |
| Component   | target step | target widget | widget class |

The 422 is therefore **not** evidence that the server refuses cross-surface
triggers. It is evidence that the server validates the record against the
target, and that the first attempt sent an inconsistent pair. Whether a
_consistent_ rewritten pair is accepted is still open — and is precisely what
the next round tests.

**Measurement note.** Tulip's clientLogger holds a `console` reference captured
at startup, so a console hook installed later never sees its lines — the first
version of the test reported "logged nothing" while the log was plainly on
screen. It now takes its verdict from the paste API call's status and response
body, which is the better signal anyway: it carries the server's own reason.

### The shape that works

A browser session against a live instance ran the full matrix. **Every row was
accepted with `201 Created`**, including a control row that pasted an unmodified
payload to prove the synthetic event path itself:

| Source          | Rewritten to                          | Destination      | Result |
| --------------- | ------------------------------------- | ---------------- | ------ |
| Button          | _unmodified_ (control)                | that button      | 201    |
| On step enter   | `button-press` + target `widgetId`    | that button      | 201    |
| Button          | `step-open` + current `stepId`        | that step        | 201    |
| Button          | `app-start`                           | app level        | 201    |
| On step enter   | `app-start`                           | app level        | 201    |
| App started     | `step-open` + current `stepId`        | that step        | 201    |
| On step enter   | `interval` + `args: { interval: 30 }` | Timers           | 201    |
| Timer           | `step-closed` + current `stepId`      | On step exit     | 201    |
| Custom widget A | `custom-widget-event` → **widget B, a different custom widget type** | widget B | 201 |

Verified afterwards: each trigger is in its destination list, the editor opens
with the destination's `When` already filled in, a `show-message` action
survived the move intact, and **all of them are still there after a hard
reload**. Pasted triggers are auto-named `<source> (Copy)`, so the toggle needs
no naming logic.

**Two fields the earlier model missed**, both of which fail Tulip's own
client-side codec _before_ any request is made:

1. **The ids must be absent, not `null`.** An app-class payload has no `stepId`
   or `widgetId` key at all; a step-class one has `stepId` and no `widgetId`.
   Setting them to `null` produces "Clipboard content was not valid
   AppClipboardContent" and no API call. `delete` passes.
2. **`haltOnError`.** App- and step-class records carry `haltOnError: true`;
   widget-class records don't carry the key. It has to be added moving up to
   step or app level and deleted moving down onto a widget.

So the per-class record shape is:

| Field         | App class | Step class | Widget class |
| ------------- | --------- | ---------- | ------------ |
| `stepId`      | absent    | string     | string       |
| `widgetId`    | absent    | absent     | string       |
| `haltOnError` | `true`    | `true`     | absent       |
| `event.type`  | app class | step class | widget class |

Everything else is identical across surfaces and is passed through exactly as
copied — including the stale `event.id`, which names the _source's_ event slot
and which the server does not mind.

Two failure signatures are worth telling apart: no `/paste` call plus
"not valid AppClipboardContent" means the codec rejected the shape (usually a
`null` where a key should be absent), while a `/paste` that returns 4xx is the
server, and its body names the field. The 422 from the earlier round was the
second kind — an inconsistent (target, record) pair, exactly as suspected.

### Which hypothesis was right

Of the three shapes this could have taken, the first is what Tulip does:

| Hypothesis                                                | Verdict                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| **H1** payload carries an owner discriminator, checked at paste | **Confirmed** — payload read every time, guard right after |
| **H2** copy never reaches a shared clipboard (in-memory / localStorage slot) | Ruled out — `clipboard.write()`, no storage writes |
| **H3** guard is downstream, at Save                        | Not reached — the editor never opens, so the gate is upstream of it |

H3 is not fully excluded as a _second_ gate: the editor opening does not prove
Save will accept a cross-type trigger. That is the first thing to test once a
rewrite works, and if the server refuses, the toggle should not ship.

## Interception layers available

Ranked by preference, with the precedent already in this repo:

1. **Rewrite the payload as Tulip reads it** (MAIN world) — now that paste is
   known to be a trusted `paste` event, the hook is
   `DataTransfer.prototype.getData`. Wrap it; when Tulip's handler asks the
   pasted `DataTransfer` for its payload during a paste in the app editor,
   return a rewritten string instead. Tulip's own trusted event and its own
   code path run unchanged — it simply reads a payload that says the trigger
   belongs to the target. Nothing persists, so disabling reverts by passing
   payloads straight through.

   This is why the wrapper beats the two obvious alternatives: the event's
   `clipboardData` is read-only, so it cannot be edited in place, and
   re-dispatching a synthetic `ClipboardEvent` would hand Tulip an untrusted
   event and a re-entrancy problem. Rewriting the getter sidesteps both.
2. **React fibers** (MAIN world) — `filters-builder-main.js` and
   `expression-editor-fuzzy-main.js` show the pattern: find the owning component
   by climbing from a DOM node and call its props directly. This is the fallback
   for H2, where the clipboard is not the channel and the paste handler's state
   has to be reached in the page.
3. **Driving Tulip's own controls** (isolated world) — the
   `snap-to-grid` / `option-sets-trigger` pattern: write through the real inputs
   with native setters and bubbled events so Tulip's commit handlers run. Useful
   for filling in a `When` the payload could not carry, not for the paste itself.
4. **Patching the save API** (MAIN world fetch/XHR, as in
   `app-list-date-columns-main.js`) — **out of scope.** Forging what the editor
   sends on Save would write app definitions Tulip's UI never produced. If H3
   turns out to be true, the answer is "this can't be done safely", not this.

## Rewrite strategies

Assuming H1, two shapes of fix, to be chosen once the event vocabulary is known:

**A — discriminator patch.** Parse the payload, replace only `trigger.event`
and the owner ids (`stepId`, `widgetId` — set for a widget target, cleared for a
step or app target), leave `clauses` untouched. Minimal, and it keeps whatever
else Tulip's version of the payload contains that we don't understand. This is
the expected shape of the fix.

**B — envelope swap.** Keep only `name`, conditions and actions from the copied
trigger and rebuild the envelope in the shape the target surface's own copy
payload uses. Needed if step/app/widget triggers turn out to be structurally
different records rather than the same record with different owner fields —
which is exactly what collecting one payload per surface will show.

**The mapping is the target's, not the source's.** Because the destination is
picked by clicking a specific **Paste trigger** button (see below), the target
event is never in doubt: the button in the "On step exit" list writes
`event.type = "step-closed"`, the one under Timers writes `"interval"`, the one
in App started writes `"app-start"`. There is no guessing and no "leave the When
unset" fallback — the affordance carries the answer.

And since the dispatcher routes on the trigger's class, writing that one string
is also what aims the paste: `step-closed` makes Tulip take the step branch and
target the current step, `app-start` makes it take the app branch. The button
supplies an event type; Tulip supplies everything else.

## Toggle sketch

```js
{
  id: 'paste-trigger-anywhere',
  name: 'Paste Trigger Anywhere',
  description:
    'In the app editor, add a "Paste trigger" button to every trigger list — App started/completed/cancelled, On step enter/exit, Timers, Machines & devices, and each custom widget event — so a copied trigger can be pasted across those surfaces instead of only onto a selected component. The trigger editor opens pre-filled as usual with the event set to the list you pasted into, and nothing is saved until you press Save.',
  defaultEnabled: false,
}
```

Three parts, following `filters-builder` / `app-list-date-columns`:

- `toggles/paste-trigger-anywhere.js` (isolated, default array) — the toggle
  lifecycle via `registerToggle`, the app-version-editor path check (the
  `EDITOR_PATH` regex from `snap-to-grid.js`), and it sets/clears
  `<html data-tulbelt-pta-enabled>`.
- **The paste buttons** (same isolated script) — one injected per trigger list
  section, in the `option-sets-trigger` / `collapse-tables-tile` style: find the
  section, clone Tulip's own button so it looks native, mark it with a
  `data-tulbelt-pta-*` attribute, and remove every one of them on disable.
  Each button knows the `event` its section represents. On click it reads the
  clipboard, rewrites the payload for that event, and hands it to Tulip's paste
  path — the click is a user gesture, so `navigator.clipboard.read()` is
  allowed.
- `toggles/paste-trigger-anywhere-main.js` (MAIN world, `document_start`) —
  gets the rewritten payload into Tulip's paste path. Two routes, and the bundle
  grep decides which:

  1. **Synthesize the paste.** Because our button owns the gesture, it can build
     a `DataTransfer` holding the rewritten `text/html` and dispatch a
     `ClipboardEvent('paste')` at whatever element Tulip listens on. No patching
     at all, and nothing to revert. Risk: the event is untrusted, and Tulip may
     still take its destination from editor selection state rather than from the
     payload — in which case the button alone can't aim it.
  2. **Wrap `DataTransfer.prototype.getData`.** Rewrite the string as Tulip's
     handler reads it, keeping Tulip's own trusted event. Rewrite only when
     **all** of: the `<html>` flag is set, the string carries a
     `data-tulip-clipboard` attribute, the base64 decodes to JSON with
     `isTulipAppClipboardContent === true` and `clipboardType === "Trigger"`, and
     a Tulbelt paste is in flight. Every other read — every ordinary text paste
     in the editor — returns the original string byte-identical.

  Route 1 is cleaner if Tulip's handler is payload-driven; route 2 is the
  fallback, and the two compose (synthesize the event, serve the payload through
  the wrapper) if the handler insists on a trusted event's own `clipboardData`.

Revert: clearing the flag makes the wrapper a pass-through on the very next
read. The wrapper itself stays installed for the life of the page — Tulip may
hold a reference to the wrapped function, so unwrapping is the riskier option.
Nothing is written to the DOM or to storage, so there is nothing else to undo.

Debug logging goes through `window.__tulbelt?.log?.('paste-trigger-anywhere', …)`
from the isolated half and the `tulbelt:devlog` CustomEvent bridge from the MAIN
half (see [devtools.md](./devtools.md)).

## Risks and honest limits

- **Actions that referenced the old owner.** Moving a custom widget trigger to a
  button can leave actions pointing at an event payload that no longer exists.
  They will surface in the editor; the toggle must never quietly drop or rewrite
  them.
- **Server-side validation is in the path, not after it.** Paste calls an API
  that creates the trigger. If that API validates the event against the
  destination, no client-side rewrite can help, and the toggle should not ship.
  If it accepts, the trigger it creates is a real one — no half-built record.
  Either way the toggle must never try to get around a server refusal.
- **Snapshot first.** The toggle is off by default and its description should
  say plainly that it produces trigger records Tulip's UI would not otherwise
  create.
- **Version fragility.** The payload shape is Tulip's private format; a Tulip
  release can change it. The rewrite must fail closed — if the payload doesn't
  match what we expect, pass it through untouched and let Tulip refuse the paste
  exactly as it does today.

## Open questions

Answered so far: the clipboard is the channel (`navigator.clipboard.write`), the
read is a trusted `paste` event on the `text/html` flavor, the payload _is_ read
on a refused paste, refusal is silent, and the owner binding in the payload is
`trigger.event.type`.

Also answered: the event vocabulary for the app- and step-level surfaces, and
that all three binding levels share one record shape (see
[the vocabulary table](#the-event-vocabulary)).

Also answered by the dispatcher: what routes the paste (the trigger's own
class), that Tulip re-derives `event.type` for widget targets itself, and that
the only explicit refusals are the two custom-widget field comparisons and the
form-trigger one.

Answered by the browser round: the paste API **accepts** consistent
cross-surface rewrites (all nine rows, `201`), the server does **not** mind a
stale `event.id`, actions survive the move, the created trigger is real and
survives a reload, and a custom-widget trigger can move to a **different**
custom widget type. There is no second gate at Save because there is no Save —
the record is created by the paste itself.

## Two vocabularies for the same events

Worth knowing before touching anything that reads an event type: Tulip names
widget events **twice**, and the spellings are not mechanically related.

| Trigger list section (`group.types[0]`) | Clipboard payload (`event.type`) |
| --------------------------------------- | -------------------------------- |
| `input_enter`                            | `enter-press`                    |
| `input_exit`                             | `input-exit`                     |

Most pairs differ only by the separator; `input_enter` does not. So a section's
event type cannot be used as a payload event type without translation, and a
blanket underscore-to-hyphen swap invents `input-enter`, which is not an event
at all. The toggle lists the irregular pair, converts the regular ones, and
then **checks the result against the payload vocabulary** — an unknown spelling
falls through rather than being sent.

This cost a round: the section's type was being read correctly, failing the
lookup, and being silently discarded, so a trigger pasted at "On input exit"
landed in "On enter press". The underscore spellings for `input-change`,
`row-select`, `signature-complete` and `button-press` have not been observed —
those widgets are single-section wherever they were checked — so if one of them
turns out to be irregular too, it will present the same way.

Single-event components (button, interactive table) name no type and carry no
label: they report `types: null` and an empty heading. They land on a generic
widget event and Tulip re-derives the one event they fire, which is correct, but
by that route rather than by being named.

## The When dropdown is Tulip's, not ours

After any paste onto a widget, the trigger editor's **When** dropdown lists the
full cross-widget event vocabulary — a text input is offered "signature is
completed", "a row is selected" and "Custom Widget event occurs", none of which
it can fire. **A native Ctrl+V paste produces the identical list**, while a
trigger created normally in that widget offers only its own events. So both
paste paths widen it and Tulip's own is one of them; this is not something the
toggle causes or should correct.

At step level the same breadth is legitimate: a step trigger's When spans
device / timer / machine / step opened / step closed, and changing it genuinely
moves the trigger between the Timers, Machines & devices and On step exit
sections.

## The stress run

Five sources — one per class: an app trigger (no ids), a step trigger
(`stepId`), a **Timer** (carries `event.args`), a **button** (both ids), a
custom widget trigger (`eventName` + `customWidgetId`) — against **every** paste
destination: the three app lists, a step's four lists, a button's panel, a text
input's two sections, an interactive table, and every event section of two
_different_ custom widget types. 75 cells, every one `201`.

What it establishes beyond "it works":

- **The `When` is the destination's, whatever the source.** All five sources
  produce the same `When` at a given destination — the source really does
  contribute only its clauses.
- **Custom widget sections don't bleed.** Widget B's three sections received
  triggers carrying three distinct `eventName`s, each matching the icon that was
  clicked, including when the source was a _different_ custom widget type whose
  `eventName` had to be replaced rather than carried.
- **`args` stay where they belong.** Timers got `{ interval: 30 }` on all five
  including sources with no args at all; Machines & devices got
  `{ driver: "", event: "" }`; the other eleven destinations got none. The Timer
  source's args never appeared anywhere else.
- **Actions survive**, including a two-action source arriving with both actions
  in order.
- **Machines & devices works unset.** Accepted with empty-string args, the
  driver picker opens and populates the device-output control, and switching the
  `When` from device to machine in the same editor works. It does not arrive
  pointing at another trigger's device.

One wording note: the doc's expected `When` for Machines & devices was "a device
output"; the option's literal text is `device`, with the driver as a separate
control beside it. Cosmetic.

## Residual risk

Small and named, rather than unknown:

1. **Four unobserved section spellings.** `input-change`, `row-select`,
   `signature-complete` and `button-press` have never been seen in their
   underscore form, because the widgets carrying them were single-section
   everywhere they were checked — and a single-section widget doesn't need the
   name, since Tulip re-derives the event. If one of them is irregular the way
   `input_enter` was, it would only matter on a **multi-section** widget of that
   kind, and it would present as a paste landing in the wrong section rather
   than as an error.
2. **Form triggers** are refused by Tulip's own dispatcher and are not offered as
   a destination. A form trigger used as a _source_ was never tested.
3. **Cross-step pasting** is not attempted and shouldn't be relied on: a paste
   button always sits in the surface it targets.
4. **Actions that referenced the old owner** are left exactly as copied, visible
   in the editor for the user to fix. That is deliberate — the alternative is
   silently rewriting someone's logic.

## Running the probe

1. Open an app in the app editor with at least one trigger to copy.
2. Open DevTools → **Console**, leaving the context dropdown on **top** (the
   page's own context — _not_ the Tulbelt context this time; the probe has to
   see Tulip's `navigator.clipboard`).
3. Paste the whole of
   [`probes/trigger-clipboard-probe.js`](./probes/trigger-clipboard-probe.js)
   and press Enter. It prints `[tpa] armed`.
4. Reproduce, calling `__tpaNote('...')` between steps to label them:
   - copy a button trigger, paste it onto an **interactive table or input**
     (the cross-component case that already works — the baseline);
   - copy an **On step enter** trigger and try to paste it onto a button
     (refused);
   - copy a button trigger and try to paste it onto a step or app-level list
     (refused — and worth capturing precisely because there is nothing to aim
     Ctrl+V at, which is the gap the paste buttons fill);
   - if custom widgets are in play, copy a trigger from one custom widget type
     and try to paste it onto a different one (refused).
5. Also copy one trigger from **each surface** — App started, App completed,
   App cancelled, On step enter, On step exit, Timers, Machines & devices, a
   component, a custom widget — so the report carries a reference payload for
   each. These are what fill in the event vocabulary.
6. Run `copy(__tpaDump())` and paste the JSON into the chat — that is the
   copy/paste-relevant subset (payloads, `getData` reads, Tulip's own
   `[Copy/Paste]` lines). `copy(__tpaReport())` gives everything including
   clicks and storage writes, if the dump turns out to be missing something.
   `__tpaStop()` removes the probe; reloading the tab also clears it.

The report replaces the instance hostname with `your-instance.tulip.co`, but a
tenant name appearing as plain text inside a captured payload is **not**
detected — and a trigger payload always carries one, in `sourceCustomer`, plus
app, workspace and user ids. The [devtools.md](./devtools.md) rule applies:
chat or gitignored local notes only, never a tracked file.

### Collecting one payload per surface

With the probe loaded, copy a trigger and then label it:

```js
await __tpaDecode("App started");
```

Repeat for App completed, App cancelled, On step enter, On step exit, Timers,
Machines & devices, a component, and each custom widget. Every decode is filed
into the same report, and together they are the event vocabulary the paste
buttons write into.

Without the probe, the same thing by hand:

```js
const html = await (await navigator.clipboard.read())
  .flatMap((i) => (i.types.includes("text/html") ? [i] : []))[0]
  .getType("text/html")
  .then((b) => b.text());
JSON.parse(atob(html.match(/data-tulip-clipboard="([^"]+)"/)[1]));
```

### Finding where the paste buttons go

With a trigger list open in the context pane, `__tpaPane('step triggers')`
prints its structure (tags, testids, first class, own text) and files it in the
report. One per surface — app-level list, step-level list, a custom widget's
event sections — is enough to work out the injection point and how a section
identifies itself.

### Grepping Tulip's bundles

[`probes/bundle-grep.js`](./probes/bundle-grep.js) re-fetches the editor
bundles the tab already has and prints the code around the clipboard strings
(`isTulipAppClipboardContent`, `data-tulip-clipboard`, the `[Copy/Paste]` log
line, `button-press`). Paste it, run `await __grep()`, then `copy(__grepJson)`.
That should show the paste handler itself: the event-type enum, whether the
target's step/widget id is taken from the selection, and the predicate that
refuses the paste.

## Sources

- [Copy and paste app elements — Tulip Knowledge Base](https://support.tulip.co/docs/copy-and-paste-app-elements)
- [Widget Triggers](https://support.tulip.co/docs/widget-triggers) ·
  [Step level triggers](https://support.tulip.co/docs/step-level-triggers) ·
  [App Level Triggers](https://support.tulip.co/docs/app-level-triggers)
- [Triggers](https://support.tulip.co/docs/triggers) ·
  [Interactive table widgets](https://support.tulip.co/docs/interactive-table-widgets) ·
  [Custom Widgets](https://support.tulip.co/docs/custom-widgets)
- [Keyboard shortcuts in the app editor and player](https://support.tulip.co/docs/how-to-use-keyboard-shortcuts-in-the-app-editor-and-player)
- Community requests for exactly this:
  [Copy triggers from step enter event to widget event](https://community.tulip.co/t/copy-triggers-from-step-enter-event-to-widget-event/3101),
  [Copy button triggers to step trigger…](https://community.tulip.co/t/copy-button-triggers-to-step-trigger-app-started-triggers-device-machine-triggers-etc/5273),
  [Copying triggers between editor tabs](https://community.tulip.co/t/copying-triggers-between-editor-tabs/16331)
