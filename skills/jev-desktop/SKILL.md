---
name: jev-desktop
description: Run a desktop task from a recipe of prose steps. The recipe owns the verb, the order and the stopping point; TypeSafe's Jev model answers one question per step — which element the step describes. Use for a repeatable task whose steps must re-resolve against the live UI on every run, so a renamed or moved control does not break the script. Not for open-ended tasks — Jev holds no plan and no memory, so it cannot decide what to do next.
---

# jev-desktop

```sh
export TYPESAFE_API_KEY=...
node scripts/jev/run.mjs --app TextEdit --recipe scripts/jev/recipes/save-a-note.json \
  --value body="Morning over the dock." --value name=poem.txt
```

```
 1  press cmd+n  ok
 2  set-value — the main editable body of the document [Untitled 4]
    ok: agent-desktop set-value @s33yj9i0fa1yv4:e2 Morning over the dock.   conf 0.92
 3  press cmd+s  ok
 4  set-value — the field that holds the file name to save as [Untitled 4]
    ok: agent-desktop set-value @s12zr2g972nji3:e147 poem.txt   conf 0.95
 5  press return  ok
done
```

## The recipe

A JSON array. Each step is either a key combo or a verb plus a prose target.

```json
[
  { "combo": "cmd+n", "settle": 1000 },
  { "verb": "set-value", "target": "the main editable body of the document", "value": "body" },
  { "combo": "cmd+s", "settle": 1500 },
  { "verb": "set-value", "target": "the field that holds the file name to save as", "value": "name" },
  { "combo": "return", "settle": 1500 }
]
```

| Field | Meaning |
| --- | --- |
| `verb` | Any agent-desktop interaction command. |
| `target` | Prose. Describe the element the way a person would. |
| `value` | Names a `--value` key. Jev returns choices, never strings, so text is always yours. |
| `combo` | A key press. Asks Jev nothing. |
| `settle` | Milliseconds to wait after the step. |
| `direction` | For `scroll`. Defaults to down. |

Flags: `--app`, `--recipe`, `--value k=text`, `--min <p>` (default 0.55),
`--dry-run`, `--bin`.

Write the target the way a person would say it. `"the field that holds the file
name"` is a fair description. `"the textfield named Save As:"` restates the
answer and tests nothing.

## What the script decides, not Jev

- Only elements that advertise the step's verb reach the choice. A readonly
  combobox offers `click`, never `set-value`.
- Elements that are `disabled` or `hidden` are never offered.
- A cell that repeats its treeitem parent is dropped, and so is an unnamed
  element that shares its role with another. An unnamed element that is the
  only one of its role stays — a TextEdit document body is exactly that.
- When a sheet, alert, menu or popover is up, the script reads that surface
  instead of the window. In the window tree those elements carry `offscreen`
  and every one of them would be dropped.

## Where it stops

The runner exits non-zero and names the step. It never substitutes an action.

| Condition | Meaning |
| --- | --- |
| Jev answers `none` | The screen is not in the state the step expects. |
| confidence below `--min` | Two elements fit the description equally well. |
| no element supports the verb | The recipe asks for something this screen cannot do. |
| the command fails | agent-desktop returned an error; its code is printed. |

## Known limits

- Jev holds no plan and no memory. You write the order. It will not recover
  from a screen the recipe did not anticipate.
- One full snapshot per step, about 3 s. `--skeleton` is about 0.2 s but the
  runner does not drill yet.
- No retry and no backoff. A 429 ends the run.
- Held input is unavailable, so there is no drag with sustain and no held key.
  See `crates/core/src/commands/input_hold_policy.rs`.

## Checks

```sh
node scripts/jev/run.test.mjs
```
