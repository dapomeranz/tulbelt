# Show Full Trigger Value Text — design

Date: 2026-07-26
Feature id: `trigger-value-full-text`

## Problem

Static value text boxes in the trigger action editor (`input[aria-label="Value
Picker"]`, e.g. `data-testid="value-static-value-specifier"`) are one fixed-width
line. Long values — error messages, expressions pasted as text — get clipped,
and the only way to read them is to click in and arrow through.

## Behavior

A toggle. When on, any trigger-editor Value Picker text input whose text
overflows its visible width is swapped for an editable, soft-wrapping,
auto-growing box that always shows the full value. Inputs whose text fits are
left completely alone.

- **Overflow-only.** The native input stays until the value doesn't fit
  (`scrollWidth > clientWidth`, with a 1px rounding buffer). When an
  overflowing value shrinks to fit again, the native input comes back.
- **Inline-first, text-hugging.** The expanded box renders after the
  `triggerUnitStyles` container rather than in the input's slot (the input's
  wrapper span has a fixed 35px height that clips anything taller). The
  action body is a wrapping row flexbox and the box uses `flex: 0 1 auto` +
  `min-width: 0`, so it always hugs its text: beside the selects while the
  text fits in the leftover space, on its own content-width line when it
  doesn't, and compressed to the full row width (soft-wrapping onto 2+
  lines) only when the text is longer than the row.
- **Never while focused.** Swapping in either direction happens only on
  mount/reconcile and on blur — never mid-typing, so the caret is never
  yanked. Type past the edge → nothing moves until you blur.
- **Editable.** The expanded box is a real edit surface; keystrokes forward
  into the hidden native input so React state stays the source of truth.
- **Enter commits** (forwarded to the real input, then blur) instead of
  inserting a newline — `input[type=text]` values cannot contain line breaks;
  the multiline look is soft wrap only. Pasted newlines are flattened.

## Scope

All single-line text inputs with `aria-label="Value Picker"` inside the
trigger editor, detected by a `closest('[class*="triggers-editor-client"]')`
ancestor check (Tulip's trigger-editor CSS-module prefix). Nothing outside the
trigger editor is touched.

## Implementation

New content script `toggles/trigger-value-full-text.js` (isolated world,
`document_idle`, same manifest block as `action-editor-frequent.js`), using the
two proven repo patterns:

- **Hidden real + proxy** (from `action-editor-frequent.js`): the real input
  gets `data-tulbelt-fulltext-hidden="true"`; the injected stylesheet hides
  its _wrapper_ (`:has(> input[…])`) so the fixed 35px × ~175px slot doesn't
  leave an empty gap in the row. A `<textarea rows="1" wrap="soft">` proxy,
  flagged `data-tulbelt-fulltext-proxy`, is inserted after the input's
  `closest('[class*="triggerUnitStyles"]')` row and stretched to the action
  body's width (`align-self: stretch`). Key visual computed styles (font,
  padding, border, radius, colors) are copied from the real input at mount,
  while it is still visible. Auto-grow via `field-sizing: content`
  (Chrome-only extension), with a scrollHeight fallback if unsupported.
- **Native-setter write-back** (from `snap-to-grid.js`): each proxy `input`
  event writes the (newline-stripped) value into the real input through the
  native `HTMLInputElement` value setter, then dispatches bubbling `input` +
  `change` events so React's onChange runs. Enter dispatches a synthetic
  Enter keydown/keyup on the real input and blurs the proxy.

Bookkeeping mirrors `action-editor-frequent.js`: a `WeakMap` of real input →
proxy, a single `MutationObserver` on `document.body` (attached only while
enabled) that reconciles added/removed nodes, plus delegated `focusout` to
re-evaluate overflow on blur. Re-measuring a hidden input is done by
synchronously unhiding → measuring → re-hiding (no paint in between).
Disabling the toggle removes proxies, hidden flags, stylesheet, observer, and
listeners.

Registered in `features.js` as `defaultEnabled: true`, `major: true`; the
popup picks it up automatically.

## Testing

Manual (repo has no test harness):

1. Long static Text value → blur → box wraps and shows full text; grows as
   you type more.
2. Edits in the expanded box round-trip: value persists after save/reload.
3. Enter commits (same as Enter in the native input); no newline inserted.
4. Short values keep the untouched native input; shortening an expanded value
   below the fit threshold collapses back on blur.
5. Toggle off → everything restored to stock.
