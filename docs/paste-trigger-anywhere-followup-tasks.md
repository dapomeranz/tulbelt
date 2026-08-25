# Follow-up browser tasks — two paste bugs

For an agent driving real Chrome against a real Tulip instance. Two bugs found
using the shipped toggle. They share a setup, so do them in one session.

Background: [paste-trigger-anywhere.md](./paste-trigger-anywhere.md).
Repo: `thedjcdarren/tulbelt`, branch `claude/magical-mayer-ub5m6z`.

## Ground rules

- **Scratch app version only.** A paste creates a real trigger on the server the
  moment it happens — there is no save to confirm it. Every attempt below leaves
  a record behind; delete them or expect to.
- **No instance data in the repo.** Hostnames and Tulip ids (app, step, widget,
  trigger, custom widget, user) go in chat, never in a tracked file.
- **Report refusals, don't route around them.** If something is rejected, say
  what it said. A refusal we understand beats a pass we don't.
- Say which build you tested — `git rev-parse --short HEAD` of the loaded
  extension folder. Bug 1's fix is recent and testing a stale build wastes the
  round.

## Setup

1. Load the extension unpacked from the branch (`chrome://extensions` →
   Developer mode → Load unpacked → repo folder). **Reload the extension AND the
   Tulip tab** after any pull.
2. Tulbelt popup → click the **Tulbelt** title five times (subtitle gains
   "· developer") → enable **Paste Trigger Anywhere**.
3. Open a scratch app version. A paste icon should appear beside every trigger
   list heading, and beside the "Triggers" heading in a single-event widget's
   panel.
4. In the page console (context **top**, not Tulbelt): `window.__ptaDebug = true`.
   That makes the toggle print what each click resolved and sent.

You will need a widget with **two or more trigger sections** — a text input has
"On enter press" and "On input exit" — and, for bug 2, a custom widget too.

---

## Bug 1 — a multi-section widget pasted into the wrong section — FIXED

**Was:** clicking the paste icon beside "On input exit" put the trigger in "On
enter press".

**Cause — two vocabularies.** Tulip names widget events twice, and the two
spellings are not mechanically related:

| Trigger list section (`group.types[0]`) | Clipboard payload (`event.type`) |
| --------------------------------------- | -------------------------------- |
| `input_enter`                            | `enter-press`                    |
| `input_exit`                             | `input-exit`                     |

The section **did** name its own event; the code looked it up in the payload
vocabulary, found nothing, and silently discarded it — then fell back to a
generic widget event, which Tulip re-derived into the component's default: the
first section. A value that was present and thrown away, not a value that was
missing.

Note `input_enter` → `enter-press`, not `input-enter`. A blanket
underscore-to-hyphen swap invents an event that does not exist, so the fix
lists the irregular pair and converts the regular ones **then checks the result
against the payload vocabulary** — a wrong guess can never be sent.

**Ruled out:** Tulip does not override the type. Dispatching a hand-built
payload with `event.type: "input-exit"` landed the trigger in On input exit,
with the editor showing "input is exited", and it survived a reload.

**Also learned:** single-event built-ins (button, interactive table) report
`types: null` and an empty label, so neither the primary path nor the label
fallback fires for them. They land on the generic widget event and Tulip
re-derives the one event they fire — correct, but by that route rather than by
being named.

## Bug 2 — the When dropdown offers events from other surfaces — NOT OURS

The control settled it. Pasting the same button trigger onto a text input, the
When dropdown offered eight entries — including "signature is completed", "a row
is selected" and "Custom Widget event occurs", none of which a text input can
fire — and **a native Ctrl+V paste produced the identical eight**. A trigger
created normally in that widget offers only its own two.

So both paste paths widen the list to the full cross-widget vocabulary, and
Tulip's own is one of them. The toggle is not causing it and should not try to
correct it.

One nuance worth keeping: at **step** level a spanning list is legitimate. A
native step-enter trigger offers device, timer, machine, step opened and step
closed — all step-class — and changing the When genuinely moves the trigger
between the Timers / Machines & devices / On step exit sections. This only reads
as a bug in the widget case.

## If more browser work is needed

The setup above still applies. Worth knowing for the next round:

- **Check the loaded build first.** A previous round tested a stale build; the
  giveaway was that `window.__ptaDebug = true` produced no `[tulbelt:pta]` lines
  at all, since the debug path and the fix shipped in the same commit. Reload
  the extension *and* the tab after pulling.
- **The When control is a native `<select>`**, so its open popup is OS-drawn and
  never appears in a page screenshot. Temporarily setting `size=8` on the select
  renders the options inline where they can be captured.
