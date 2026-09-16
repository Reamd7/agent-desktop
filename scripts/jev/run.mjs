#!/usr/bin/env node
/**
 * Recipe runner. You own the sequence; Jev resolves one slot per step.
 *
 *   node scripts/jev/run.mjs --app TextEdit --recipe recipes/save-a-note.json \
 *     --value body="..." --value name=poem.txt
 *
 * Each step names a verb and describes its target in plain prose. The script
 * snapshots, keeps only the elements that support that verb, and asks Jev one
 * question: which of these does the description mean. Jev never chooses the
 * verb, never chooses the order, and never decides when the task is done --
 * those are the recipe's job, and a Choice primitive cannot hold them.
 *
 * A step with a `combo` sends a key and asks Jev nothing.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.typesafe.ai/v1/systemone";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NO_MATCH = "none";

/** The AX action a verb needs. A verb absent here is not filtered by action. */
const NEEDS_ACTION = {
  click: "Click",
  "right-click": "RightClick",
  toggle: "Toggle",
  check: "Toggle",
  uncheck: "Toggle",
  expand: "Expand",
  collapse: "Collapse",
  scroll: "Scroll",
  "scroll-to": "Scroll",
  "set-value": "SetValue",
  clear: "SetValue",
  focus: "SetFocus",
};

/** Verbs whose last argument is caller-supplied text. */
const TAKES_TEXT = new Set(["type", "set-value", "select"]);

const quoted = (s) => (s ? ` "${s}"` : "");

export const collect = (tree) => {
  const found = [];
  const walk = (node, path, parentRole) => {
    const self = `${node.role}${quoted(node.name)}`;
    if (node.ref_id) found.push({ ...node, path, parentRole });
    const next = node.children?.length ? [...path, self] : path;
    for (const child of node.children ?? []) walk(child, next, node.role);
  };
  walk(tree, [], null);
  return found;
};

export const overlayRole = (tree) => {
  let found = null;
  const walk = (n) => {
    if (!found && ["sheet", "alert", "menu", "popover"].includes(n.role)) found = n.role;
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return found;
};

export const isReachable = (node) => {
  const s = node.states ?? [];
  return !s.includes("disabled") && !s.includes("hidden");
};

/**
 * Drops elements Jev cannot tell apart. A macOS open panel repeats every
 * treeitem as a cell and lists every file as an unnamed textfield; offering
 * all of them spreads one real choice across a hundred look-alikes. An
 * unnamed element that is the only holder of its role is still nameable.
 */
export const isDistinct = (node, peers) => {
  if (node.role === "cell" && node.parentRole === "treeitem") return false;
  if (node.name || node.description) return true;
  return peers.filter((p) => p.role === node.role).length === 1;
};

export const describe = (node) => {
  const parts = [`${node.role}${quoted(node.name ?? node.description)}.`];
  if (!node.name && !node.description) parts.push("The only one of its kind on screen.");
  if (node.value) parts.push(`Holds "${String(node.value).slice(0, 80)}".`);
  if (node.path.length) parts.push(`Inside ${node.path.join(" > ")}.`);
  if (node.states?.length) parts.push(`States: ${node.states.join(", ")}.`);
  return parts.join(" ");
};

/** Only elements that can actually receive this step's verb reach the choice. */
export const candidatesFor = (refs, verb) => {
  const need = NEEDS_ACTION[verb];
  const live = refs.filter(isReachable);
  return live.filter(
    (n) =>
      isDistinct(n, live) &&
      (!need || (n.available_actions ?? []).includes(need) ||
        (verb === "set-value" && (n.available_actions ?? []).includes("TypeText"))),
  );
};

export const buildRequest = (step, surface, candidates) => ({
  state: { step: step.target, verb: step.verb, app: surface.app, window: surface.window },
  model: "jev-latest",
  questions: {
    target: {
      type: "choice",
      instructions:
        "Which element does `step` describe? Match the description against each element's role, label, value and place in the tree. Every option here already supports the operation in `verb`, so judge identity only.",
      criteria: {
        ...Object.fromEntries(candidates.map((n) => [n.ref_id, describe(n)])),
        [NO_MATCH]: "Nothing on screen matches the description. The screen is not in the state this step expects.",
      },
    },
  },
});

export const readAnswer = (body) => {
  const a = body?.answers?.target;
  if (a?.type !== "choice") return { error: "response carried no choice answer" };
  return { id: a.choice, confidence: a.confidence };
};

export const toArgv = (step, ref, values) => {
  const argv = ref ? [step.verb, ref] : [step.verb, step.combo];
  if (step.verb === "scroll") argv.push("--direction", step.direction ?? "down");
  else if (TAKES_TEXT.has(step.verb)) argv.push(values[step.value] ?? step.value ?? "");
  return argv;
};

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
  return readAnswer(await res.json());
};

const main = async (argv) => {
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? null : argv[i + 1];
  };
  const app = flag("app");
  const recipePath = flag("recipe");
  const min = Number(flag("min")) || 0.55;
  const dryRun = argv.includes("--dry-run");
  const bin = flag("bin") ?? (existsSync(join(REPO, "target/release/agent-desktop"))
    ? join(REPO, "target/release/agent-desktop")
    : "agent-desktop");
  const values = Object.fromEntries(
    argv.flatMap((a, i) => (argv[i - 1] === "--value" ? [a.split(/=(.*)/s).slice(0, 2)] : [])),
  );

  if (!app || !recipePath) {
    console.error('usage: run.mjs --app <name> --recipe <file.json> [--value k=text] [--min p] [--dry-run]');
    process.exit(2);
  }
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY unset");
    process.exit(1);
  }

  const recipe = JSON.parse(readFileSync(recipePath, "utf8"));

  for (const [i, step] of recipe.entries()) {
    const n = String(i + 1).padStart(2);

    if (step.combo) {
      const out = dryRun ? { ok: true } : run(bin, ["press", step.combo]);
      console.log(`${n}  press ${step.combo}  ${dryRun ? "(dry run)" : out.ok ? "ok" : `FAILED ${out.error?.code}`}`);
      if (!out.ok) process.exit(1);
      if (step.settle) run(bin, ["wait", String(step.settle)]);
      continue;
    }

    let snap = run(bin, ["snapshot", "--app", app, "-i", "--compact"]);
    if (!snap.ok) {
      console.error(`${n}  snapshot failed: ${snap.error?.code} ${snap.error?.message}`);
      process.exit(1);
    }
    const overlay = overlayRole(snap.data.tree);
    if (overlay) {
      const surfaceSnap = run(bin, ["snapshot", "--app", app, "--surface", overlay, "-i", "--compact"]);
      if (surfaceSnap.ok) snap = surfaceSnap;
    }

    const candidates = candidatesFor(collect(snap.data.tree), step.verb);
    if (candidates.length === 0) {
      console.error(`${n}  no element on screen can take "${step.verb}"`);
      process.exit(1);
    }

    const surface = { app: snap.data.app ?? app, window: snap.data.window?.title ?? overlay ?? null };
    const answer = await ask(buildRequest(step, surface, candidates));
    if (answer.error) {
      console.error(`${n}  ${answer.error}`);
      process.exit(1);
    }

    const where = surface.window ? ` [${surface.window}]` : "";
    console.log(`${n}  ${step.verb} — ${step.target}${where}`);
    if (answer.id === NO_MATCH) {
      console.error(`    no match (${answer.confidence.toFixed(2)}) — the screen is not in the expected state`);
      process.exit(1);
    }
    if (answer.confidence < min) {
      console.error(`    unsure: ${answer.id} at ${answer.confidence.toFixed(2)}, below ${min}`);
      process.exit(1);
    }

    const command = toArgv(step, answer.id, values);
    if (dryRun) {
      console.log(`    would run: agent-desktop ${command.join(" ")}   conf ${answer.confidence.toFixed(2)}`);
      continue;
    }
    const out = run(bin, command);
    console.log(
      `    ${out.ok ? "ok" : `FAILED ${out.error?.code}`}: agent-desktop ${command.join(" ")}   conf ${answer.confidence.toFixed(2)}`,
    );
    if (!out.ok) process.exit(1);
    if (step.settle) run(bin, ["wait", String(step.settle)]);
  }
  console.log("done");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
