---
name: jev-desktop
description: Resolve one plain-language intent against the live screen and get back the agent-desktop command that carries it out, without ever reading the accessibility tree. Use when driving a desktop app step by step and you want to keep a 150-element JSON tree out of your context — you hold the goal and the memory, the script and TypeSafe's Jev model hold the screen. Covers which element, which command, and whether it is safe to act.
---

# jev-desktop

You keep the goal, the plan and the memory. You send one sentence. You get back
one small object. The tree never enters your context.

```sh
node scripts/jev/act.mjs --app TextEdit --execute \
  --text "Morning over the dock." "type this text into the main writing area"
```

```json
{
  "ok": true,
  "app": "TextEdit", "window": "Untitled 3", "surface": "sheet",
  "element": { "ref": "@s1:e139", "role": "textfield", "name": "Save As:",
               "where": "sheet \"save\" > group" },
  "command": "set-value",
  "argv": ["set-value", "@s1:e139", "poem.txt"],
  "decision": "act",
  "confidence": { "target": 0.99, "command": 0.88 },
  "gates": { "present": 0.94, "destructive": 0.31, "needs_text": 0.87 },
  "runner_up": [{ "ref": "@s1:e137", "what": "textfield", "p": 0.02 }],
  "notes": [],
  "executed": { "ok": true, "delivery": "delivered_verified" }
}
```

## Calling it

| Flag | Meaning |
| --- | --- |
| `--app <name>` | Required. |
| `--execute` | Run the command when `decision` is `act`. Without it, nothing runs. |
| `--text "…"` | Text the intent needs. Jev returns choices, never strings. |
| `--root @ref` | Resolve inside one container instead of the whole window. |
| `--bin <path>` | agent-desktop binary. Defaults to the release build, then `PATH`. |

**Phrase the intent as an action, not as an element.** `"type this text into the
main writing area"` resolves to `type`. `"the main writing area"` names no
operation and resolved to `focus` in testing. Describe the target the way a
person would — `"the field holding the name the file will be saved under"` —
not the way the tree names it.

## Reading `decision`

| `decision` | What it means | What you do |
| --- | --- | --- |
| `act` | One element clearly matches and the confidence clears the bar for this action's risk. | Nothing. With `--execute` it already ran. |
| `confirm` | The match is plausible but under the bar. | Ask the user, or re-phrase the intent and call again. |
| `abstain` | Jev answered `none`, the element is probably not on this screen, or two elements fit equally. | The screen is not where you think. Open the surface you need, then call again. |
| `needs_text` | The command takes text and none was supplied. | Call again with `--text`. |

`why` always carries the reason in one sentence. `runner_up` shows what else it
considered, which is usually enough to tell a wrong screen from a vague intent.

## What the script decides, not Jev

- **Risk sets the bar.** The answer says what; confidence says whether to act.
  An ordinary action needs 0.70. One that Jev rates `destructive` at 0.50 or
  more needs 0.90 — writing a file, deleting, sending, confirming a warning.
  Below 0.55 nothing acts at all.
- **The command is reconciled against the element.** Both questions are
  answered in parallel and neither sees the other, so code checks the chosen
  verb against the element's advertised actions. A readonly combobox gets
  `click`, never `set-value`. A `--text` payload with a non-text verb corrects
  the verb, because the caller supplying text is evidence Jev does not have.
- **An open surface wins.** When a sheet, alert, menu or popover is up, the
  script reads that surface instead of the window. In the window tree those
  elements carry `offscreen` and would all be dropped.
- **Disabled and hidden elements are never offered.** Everything else is,
  including unnamed rows — a row is told apart by the value it holds, and a
  Choice does better with the full list than with a shortlist.

## How the request is shaped

One call carries five questions. They are answered in parallel, so the
speculative ones cost tokens and no latency.

| Question | Type | Asks |
| --- | --- | --- |
| `target` | choice | Which element the intent refers to, plus `none`. |
| `command` | choice | Which of the 16 interaction verbs it asks for. |
| `present` | noul | Is the thing on this screen at all? |
| `destructive` | noul | Would this be hard to undo? |
| `needs_text` | noul | Does this need text from the caller? |

A Choice accepts 255 options, so up to 254 elements go in one pass. When the
first pass lands under 0.70 the top five are re-asked with richer descriptions.
A screen with more than 254 elements says so in `notes`; use `--root @ref`.

## Known limits

- One snapshot per call, about 3 s on a dense app. `--root` is far cheaper.
- No retry and no backoff. A 429 ends the call.
- Held input is unavailable, so no sustained key and no drag with hold. See
  `crates/core/src/commands/input_hold_policy.rs`.
- `press` is not resolved here. It needs no element, so send it directly.

## Checks

```sh
node scripts/jev/act.test.mjs
```
