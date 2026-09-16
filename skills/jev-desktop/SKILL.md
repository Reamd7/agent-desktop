---
name: jev-desktop
description: Run a desktop task with no agent in the loop. A script snapshots the app, filters the safe actions, and asks TypeSafe's Jev model to choose one; the script executes it and repeats. Use for a repeatable task written as a prose goal, where the steps must re-resolve against the live UI on every run. Not for one-off exploration — drive agent-desktop directly for that.
---

# jev-desktop

An experiment. `scripts/jev/loop.mjs` owns safety, execution and the loop. Jev
only chooses one action from a shortlist the script already vetted.

```
snapshot → build the safe shortlist → ask Jev → execute one action → repeat
```

## Run it

```sh
export TYPESAFE_API_KEY=...
node scripts/jev/loop.mjs --app TextEdit "open a new blank document"
node scripts/jev/loop.mjs --app TextEdit --value name=poem.txt --dry-run "<goal>"
```

| Flag | Meaning |
| --- | --- |
| `--app <name>` | Required. The app to snapshot and drive. |
| `--value <k>=<text>` | Supplies text the goal needs. Repeatable. |
| `--max-steps <n>` | Step cap. Default 12. |
| `--dry-run` | Print the first chosen action and stop. Executes nothing. |
| `--bin <path>` | agent-desktop binary. Defaults to the release build, then `PATH`. |

Headless only. Every step prints the chosen action, its confidence, and the two
stop probabilities.

## What the script decides, not Jev

The shortlist is the safety boundary. Jev cannot choose an action the script
did not build, so these are policy and never a judgment:

- An element must not be `disabled`, `offscreen`, or `hidden`.
- An element only contributes a verb it advertises in `available_actions`.
  A readonly combobox offers `click`, never `set-value`.
- Only `textfield`, `textarea`, `searchfield`, and `combobox` can receive
  supplied text. A scrollbar handle advertises `SetValue` too, and without
  this rule Jev will confidently type a filename into one.
- Free text must be supplied with `--value`. Jev returns choices, never
  strings, so a goal that needs text the caller did not supply cannot proceed.

## Where it stops

| Condition | Threshold |
| --- | --- |
| `goal_complete` | 0.70 |
| `needs_human` | 0.50 |
| action confidence too low | below 0.50 |
| the screen stopped changing | two identical snapshots |
| step cap | `--max-steps`, default 12 |

Every stop happens **before** the chosen action runs.

## Known limits

- One full snapshot per step, about 3 s. `--skeleton` would be about 0.2 s but
  the loop does not drill yet.
- A `check` or `uncheck` distinction is not offered; only `toggle`. A goal
  phrased as a negation has no safe way to express itself.
- No retry, no backoff. A 429 ends the run.

## Checks

```sh
node scripts/jev/loop.test.mjs
```
