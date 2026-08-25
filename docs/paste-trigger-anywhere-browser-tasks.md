# Browser tasks — Paste Trigger Anywhere

For an agent driving a real Chrome against a real Tulip instance (Claude in
Chrome, or a human with DevTools open). Four tasks, in priority order. **Task A
is the one that decides whether this feature ships**; the rest widen its
coverage.

Background, if you need it: [paste-trigger-anywhere.md](./paste-trigger-anywhere.md).
Repo: `thedjcdarren/tulbelt`, branch `claude/magical-mayer-ub5m6z`.

## Ground rules

- **Use a scratch app version.** A paste creates a real trigger on the server
  immediately — there is no save step to confirm it. An unwanted paste is a real
  record someone has to delete.
- **Never put instance data in the repo.** Hostnames and Tulip ids (app, step,
  widget, trigger, custom widget, user) go in chat, never in a tracked file.
  Findings get recorded as shapes, not values.
- If something refuses, **report the refusal** — don't retry with a different
  shape until it passes. A refusal we understand is worth more than a pass we
  don't.

## Setup

1. Load the extension unpacked from the branch (`chrome://extensions` →
   Developer mode → Load unpacked → the repo folder).
2. Open the Tulbelt popup, click the **Tulbelt** title five times quickly — the
   subtitle gains "· developer".
3. Enable **Paste Trigger Anywhere**.
4. Open a scratch app version in the editor and reload the tab.

You should now see a small **Paste trigger** button beside the heading of each
of these sections: App started, App completed, App cancelled, On step enter, On
step exit, Timers, Machines & devices. There is deliberately **no** button in a
widget's or custom widget's trigger panel yet — that is task C.

---

## Task A — does a moved trigger actually fire?

**This is the blocker.** Persistence is proven; runtime behaviour is not. A
trigger that is stored but never fires is a negative result, and the toggle
should not leave developer mode until this passes. No console work needed —
this is ordinary app building.

1. On a button in the scratch app, make a trigger whose action is visible when
   it runs — "Show message" with a distinctive string is ideal.
2. Copy it (the copy icon on its row in the trigger list).
3. Click **Paste trigger** in the **App started** section. The trigger editor
   opens with *"app is started"* as the When. Save and close it.
4. Run the app in the Player. **Does the message appear on app start?**
5. Now the reverse: copy a trigger from **On step enter**, select a button, and
   paste it there — for the moment there is no button in the widget panel, so
   use Ctrl+V if the widget panel accepts it, or skip to reporting.
6. Also worth one round: paste into **Timers** and confirm it fires on the
   interval.

Report for each: fired / did not fire / errored, and anything the Player showed.

## Task B — Machines & devices

The only destination never tested end to end. Its event carries
`args: { driver, event }` naming a specific device output, and a trigger
arriving from any other surface has no such pairing, so the button sends empty
args for the user to fill in. Tulip's own codec should accept that — its second
branch makes every arg optional — but nobody has watched it happen.

1. Copy any step or button trigger.
2. Click **Paste trigger** in **Machines & devices**.
3. Report: did the trigger editor open? Did the button say "Pasted" or show an
   error? If the paste failed, open DevTools → Network, find the `…/paste`
   request, and report its status and response body.

If it turns out empty args are rejected, the fix is to carry the args of an
existing trigger in that same section — say so and we'll do that instead.

## Task C — the ids that unlock widget and custom widget panels

The mechanism for pasting onto a widget is already proven. What is missing is
**where to read the destination's ids from the page**, and it has to work for
any widget type — including custom widgets that don't exist yet.

Two things need finding:

- **`widgetId`** of the selected widget — needed for any component destination.
- For a custom widget: its **`customWidgetId`** (the widget *type*) and, for
  **each section separately**, that section's **`eventName`**. Different custom
  widgets declare different events, and one widget can declare several — so a
  widget with three events shows three sections and needs three different
  `eventName` values. Nothing here can be hardcoded or guessed from the heading
  text; the harvest already found two different custom widget types sharing an
  identical `eventName` id, so names prove nothing.

Run [`probes/widget-target-probe.js`](./probes/widget-target-probe.js) **three
times**, and report all three JSON outputs:

1. With a **button** selected.
2. With a **different built-in component** selected — an input, an interactive
   table, whatever the instance has. (Confirms the id lives in the same place
   for every component type, rather than in something button-specific.)
3. With a **custom widget** selected — ideally one declaring **more than one
   event**, so its sections can be told apart.

To run it: DevTools → Console, context dropdown on **top** (the page's own
context, not Tulbelt), paste the file, then `__widgetProbe()`. Then type
`copy(__widgetProbeJson)` **alone at the prompt** — `copy` is a DevTools helper
and doesn't exist inside a pasted block.

The probe reports the URL's query parameters, the selected widget element's
attributes, and a climb up the React fibers above both the widget and each
trigger section — keeping any prop whose **value looks like a Tulip id**
(17 alphanumerics) rather than only props whose names I guessed. That is what
makes the result general.

If the probe reports `selectedWidget: "NOT FOUND"`, the canvas marks selection
some other way than the selectors it tries. Say so and include the
`anyCanvasWidgets` section of its output — the attributes there will show what
to match on.

## Task D — prove a widget destination end to end (optional)

Only if task C found the ids, and only if you want to de-risk before I wire the
buttons up. Using [`probes/paste-rewrite-test.js`](./probes/paste-rewrite-test.js):

```js
__pasteTest.arm()                       // click copy on an On step enter trigger
await __pasteTest.tryAs('button-press', { widgetId: '<the id task C found>' })
```

with that button selected. A `201` confirms the id you found is the right one.
For a custom widget:

```js
await __pasteTest.tryAs('custom-widget-event', {
  widgetId: '<target custom widget instance id>',
  eventName: '<that section's event id>',
  customWidgetId: '<target widget TYPE id>',
})
```

Worth knowing while testing: for **built-in** components Tulip re-derives the
event type itself — its paste path remaps a `button-press` onto whatever the
destination component actually fires. So a single code path covers every
built-in component type, present and future, given only `widgetId`. Custom
widgets are the exception, because Tulip refuses to guess among the events a
widget declares — which is exactly why their `eventName` has to be read per
section.

---

## Reporting back

For each task: what you did, what happened, and the exact text of any error.
Task C's three JSON blobs matter most — they are what the next commit is built
on. Paste them into chat; don't commit them.
