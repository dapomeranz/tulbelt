# Option Sets Export / Import — Design

Date: 2026-07-26
Feature: `option-sets-builder` (extends `toggles/option-sets-builder.js`)

## Goal

Let a user copy all of their option sets to the clipboard as a JSON payload,
send it to another person (Slack, email, anything), and let the recipient
paste it into their own Option Sets page to import them.

## Decisions

- **Export scope:** all sets in one payload. No per-set export.
- **Import merge:** add alongside. Imported sets are appended with fresh IDs
  and timestamps; existing sets are never modified or overwritten, even on a
  name collision (duplicates are allowed and can be deleted manually).
- **Import UX:** paste into a textarea. No `clipboard.readText()` — avoids
  browser permission prompts and silent failures.

## UI

Two buttons in the left list panel, directly below "+ New option set":

- **Export all** — disabled when there are no sets. On click, copies the
  payload via `navigator.clipboard.writeText()` (inside the click gesture, so
  no permission prompt). On success the button label briefly becomes
  "Copied N sets ✓" then reverts (~1.5s). On failure, the error is shown in
  the existing red `.osb-banner` via `storageError`-style messaging.
- **Import** — switches the editor panel into import mode (a new `ui.importing`
  flag, mutually exclusive with `ui.creating` and set selection). Import mode
  shows: a hint ("Paste an export from another Tulbelt user"), a textarea, an
  inline error line (hidden until a bad payload is submitted), and
  Import / Cancel buttons.

## Payload format

```json
{
  "tulbelt": "option-sets",
  "version": 1,
  "sets": [
    {
      "name": "Defect Types",
      "description": "",
      "dataType": "text",
      "options": [{ "value": "Scratch", "description": "Surface scratch" }]
    }
  ]
}
```

- Internal `id`, `createdAt`, `updatedAt` are stripped on export; import
  regenerates them.
- The `tulbelt: "option-sets"` marker is how import recognizes a valid payload.

## Import validation

Parse with `JSON.parse`. Reject (inline error, no state change) when:

- not valid JSON,
- `tulbelt !== "option-sets"`,
- `sets` is not an array,
- any set lacks a non-empty string `name`,
- any set's `dataType` is not one of `text` / `integer` / `number`,
- any set's `options` is not an array.

Per-option: `value` and `description` are coerced to strings (missing →
empty string). Unknown fields anywhere are ignored. A `version` greater
than 1 still imports if the shape checks pass (forward compatibility).

On success: append each set with a fresh `id` (`newId("os")`), fresh option
IDs (`newId("op")`), `createdAt`/`updatedAt` = now; `saveData()`; select the
first imported set; exit import mode; render.

## Error handling

- Clipboard write rejection → red banner with the error message.
- Invalid payload → inline error above the textarea; the pasted text is kept
  so the user can fix or re-paste.
- Empty textarea Import click → same inline error path ("Nothing to import").

## Out of scope

- Per-set export, replace/overwrite merge modes, file download/upload,
  clipboard read, any sharing backend. Option sets remain browser-local.
