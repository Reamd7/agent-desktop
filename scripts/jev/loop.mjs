#!/usr/bin/env node
/**
 * Jev-driven desktop loop. The script owns safety, execution and the loop;
 * Jev only chooses one action from a shortlist the script already vetted.
 *
 *   node scripts/jev/loop.mjs --app TextEdit "open a new blank document"
 *   node scripts/jev/loop.mjs --app TextEdit --value name=poem.txt --dry-run "<goal>"
 *
 * Needs TYPESAFE_API_KEY. Runs headless only.
 *
 * Jev returns choices, never strings. Any text the goal needs must be supplied
 * up front with --value <key>=<text>; the loop turns each one into a candidate
 * action and lets Jev decide which field it belongs in.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.typesafe.ai/v1/systemone";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Key combos the loop may send at any time. No ref, so no safety check. */
const KEYS = {
  return: "Press Return to commit the focused field or the default button.",
  escape: "Press Escape to dismiss the open sheet, menu or popover.",
  "cmd+s": "Press Command-S to save.",
};

/** An advertised AX action maps to exactly one agent-desktop verb. */
const FROM_ACTION = { Click: "click", Toggle: "toggle", Expand: "expand", Collapse: "collapse" };

/**
 * Roles that can hold supplied text. A scrollbar handle and a slider also
 * advertise SetValue, and offering those as text targets let Jev confidently
 * type a filename into a scrollbar.
 */
const TEXT_ROLES = new Set(["textfield", "textarea", "searchfield", "combobox"]);

const quoted = (s) => (s ? ` "${s}"` : "");
const tail = (ref) => ref.split(":").pop();

export const collect = (tree) => {
  const found = [];
  const walk = (node, path) => {
    const self = `${node.role}${quoted(node.name)}`;
    if (node.ref_id) found.push({ ...node, path });
    const next = node.children?.length ? [...path, self] : path;
    for (const child of node.children ?? []) walk(child, next);
  };
  walk(tree, []);
  return found;
};

/** The safety gate: an element the loop refuses to offer Jev at all. */
export const isReachable = (node) => {
  const states = node.states ?? [];
  return !states.includes("disabled") && !states.includes("offscreen") && !states.includes("hidden");
};

const where = (node) => (node.path.length ? ` Inside ${node.path.join(" > ")}.` : "");

/**
 * Builds the shortlist. An element only contributes verbs it actually
 * advertises, so an unsupported action can never reach the choice.
 */
export const buildActions = (refs, values = {}) => {
  const actions = [];
  for (const node of refs.filter(isReachable)) {
    const what = `${node.role}${quoted(node.name)}`;
    const has = node.available_actions ?? [];
    for (const [axAction, verb] of Object.entries(FROM_ACTION)) {
      if (!has.includes(axAction)) continue;
      actions.push({
        key: `${verb}_${tail(node.ref_id)}`,
        label: `${verb} the ${what}.${where(node)}`,
        argv: [verb, node.ref_id],
      });
    }
    if (has.includes("Scroll")) {
      for (const dir of ["down", "up"]) {
        actions.push({
          key: `scroll_${tail(node.ref_id)}_${dir}`,
          label: `Scroll the ${what} ${dir} to reveal more.${where(node)}`,
          argv: ["scroll", node.ref_id, "--direction", dir],
        });
      }
    }
    if (TEXT_ROLES.has(node.role) && (has.includes("SetValue") || has.includes("TypeText"))) {
      const verb = has.includes("SetValue") ? "set-value" : "type";
      for (const [name, text] of Object.entries(values)) {
        actions.push({
          key: `set_${tail(node.ref_id)}_${name}`,
          label:
            `Put the supplied ${name} text into the ${what}` +
            (node.value ? `, replacing "${node.value}"` : "") +
            `.${where(node)}`,
          argv: [verb, node.ref_id, text],
        });
      }
    }
  }
  for (const [combo, label] of Object.entries(KEYS)) {
    actions.push({ key: `press_${combo}`, label, argv: ["press", combo] });
  }
  return actions;
};

export const buildRequest = (goal, surface, actions, history) => ({
  state: {
    goal,
    app: surface.app,
    window: surface.window,
    recent_actions: history.slice(-5),
    action_count: actions.length,
  },
  model: "jev-latest",
  questions: {
    next_action: {
      type: "choice",
      instructions:
        "Which single action moves `goal` forward from here? Pick the one step that must happen next, not the last step of the task. Do not repeat an action in `recent_actions` that already succeeded.",
      criteria: Object.fromEntries(actions.map((a) => [a.key, a.label])),
    },
    goal_complete: {
      type: "noul",
      instructions: "Is `goal` already fully done, with nothing left for this loop to do?",
    },
    needs_human: {
      type: "noul",
      instructions:
        "Does this need a person before anything else happens: a destructive confirmation, a credential, a payment, or a state the loop cannot read?",
    },
  },
});

export const decide = (body) => {
  const a = body?.answers;
  if (a?.next_action?.type !== "choice") return { error: "no choice answer" };
  return {
    key: a.next_action.choice,
    confidence: a.next_action.confidence,
    done: a.goal_complete?.noul ?? 0,
    human: a.needs_human?.noul ?? 0,
  };
};

/** Policy, evaluated before the chosen action runs. */
export const stopReason = (d, { minConfidence = 0.5, doneAt = 0.7, humanAt = 0.5 } = {}) => {
  if (d.done >= doneAt) return `goal complete (${d.done.toFixed(2)})`;
  if (d.human >= humanAt) return `needs a person (${d.human.toFixed(2)})`;
  if (d.confidence < minConfidence) return `unsure which action (${d.confidence.toFixed(2)})`;
  return null;
};

const fingerprint = (refs) =>
  JSON.stringify(refs.map((n) => [n.role, n.name ?? "", n.value ?? "", (n.states ?? []).join()]));

const run = (bin, argv) => {
  try {
    return JSON.parse(execFileSync(bin, argv, { encoding: "utf8" }));
  } catch (e) {
    try {
      return JSON.parse(e.stdout ?? "");
    } catch {
      return { ok: false, error: { code: "SPAWN_FAILED", message: String(e.message ?? e) } };
    }
  }
};

const ask = async (payload) => {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }).catch((e) => ({ ok: false, status: 0, statusText: String(e) }));
  if (!res.ok) throw new Error(`typesafe ${res.status} ${res.statusText}`);
  return decide(await res.json());
};

const main = async (argv) => {
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? null : argv[i + 1];
  };
  const app = flag("app");
  const bin = flag("bin") ?? (existsSync(join(REPO, "target/release/agent-desktop"))
    ? join(REPO, "target/release/agent-desktop")
    : "agent-desktop");
  const maxSteps = Number(flag("max-steps")) || 12;
  const dryRun = argv.includes("--dry-run");
  const values = Object.fromEntries(
    argv.flatMap((a, i) => (argv[i - 1] === "--value" ? [a.split(/=(.*)/s).slice(0, 2)] : [])),
  );
  const goal = argv
    .filter((a, i) => !a.startsWith("--") && !(argv[i - 1]?.startsWith("--") && !["--dry-run"].includes(argv[i - 1])))
    .join(" ");

  if (!app || !goal) {
    console.error('usage: loop.mjs --app <name> [--value k=text] [--max-steps n] [--dry-run] "<goal>"');
    process.exit(2);
  }
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY unset");
    process.exit(1);
  }

  const history = [];
  let previous = null;
  let stalls = 0;

  for (let step = 1; step <= maxSteps; step += 1) {
    const snap = run(bin, ["snapshot", "--app", app, "-i", "--compact"]);
    if (!snap.ok) {
      console.error(`step ${step}: snapshot failed: ${snap.error?.code} ${snap.error?.message}`);
      process.exit(1);
    }
    const refs = collect(snap.data.tree);
    const actions = buildActions(refs, values);
    const surface = { app: snap.data.app, window: snap.data.window?.title ?? null };

    const print = fingerprint(refs);
    stalls = print === previous ? stalls + 1 : 0;
    previous = print;
    if (stalls >= 2) {
      console.log("stop: the screen stopped changing");
      return;
    }

    const d = await ask(buildRequest(goal, surface, actions, history));
    if (d.error) {
      console.error(d.error);
      process.exit(1);
    }
    const chosen = actions.find((a) => a.key === d.key);
    const reason = stopReason(d);
    const line = `${String(step).padStart(2)}  ${chosen?.label ?? d.key}`;
    console.log(`${line}\n    conf ${d.confidence.toFixed(2)}  done ${d.done.toFixed(2)}  human ${d.human.toFixed(2)}`);

    if (reason) {
      console.log(`stop: ${reason}`);
      return;
    }
    if (!chosen) {
      console.error(`chose an unknown action: ${d.key}`);
      process.exit(1);
    }
    if (dryRun) {
      console.log(`    would run: agent-desktop ${chosen.argv.join(" ")}`);
      console.log("stop: dry run");
      return;
    }

    const out = run(bin, chosen.argv);
    console.log(`    ${out.ok ? "ok" : `FAILED ${out.error?.code}`}: agent-desktop ${chosen.argv.join(" ")}`);
    history.push({ action: chosen.label, ok: out.ok, error: out.error?.code ?? null });
  }
  console.log(`stop: hit the ${maxSteps} step limit`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
