#!/usr/bin/env node
/**
 * Resolves one plain-language intent against the live screen and returns the
 * agent-desktop command that carries it out. Built to be called by an LLM
 * agent that holds the goal and the memory but never reads the tree.
 *
 *   node scripts/jev/act.mjs --app TextEdit "the button that saves the document"
 *   node scripts/jev/act.mjs --app TextEdit --execute --text "hello" "the body of the document"
 *
 * The agent sends one sentence and gets back one small object. A 150-element
 * accessibility tree never enters its context.
 *
 * Jev returns choices and probabilities, never strings. Text the intent needs
 * comes from --text.
 */
import { execFileSync, } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.typesafe.ai/v1/systemone";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NO_MATCH = "none";

/** A Choice accepts 255 options. One is reserved for the no-match outcome. */
const MAX_OPTIONS = 254;
/** Below this the wide pass is re-asked over its own top candidates. */
const RERANK_BELOW = 0.7;
const SHORTLIST = 5;

/**
 * Every interaction verb. The command question sees all of them; code then
 * checks the chosen verb against the chosen element's advertised actions,
 * because the two questions are answered in parallel and cannot see each other.
 */
const VERBS = {
  click: { what: "Activate with one press: a button, a link, a menu item, a row.", needs: "Click" },
  "double-click": { what: "Open or activate with two rapid presses.", needs: "Click", headed: true },
  "right-click": { what: "Open this element's context menu.", needs: "RightClick" },
  type: { what: "Enter supplied text keystroke by keystroke.", needs: "TypeText", text: true },
  "set-value": { what: "Replace the whole value at once, without keystrokes.", needs: "SetValue", text: true },
  clear: { what: "Empty a text field.", needs: "SetValue" },
  focus: { what: "Put keyboard focus here without activating anything.", needs: "SetFocus" },
  select: { what: "Choose a named option inside a list, dropdown or combo box.", needs: "Select", text: true },
  toggle: { what: "Flip a checkbox or switch to the state it does not hold now.", needs: "Toggle" },
  check: { what: "Put a checkbox or switch into the on state, whatever it holds now.", needs: "Toggle" },
  uncheck: { what: "Put a checkbox or switch into the off state, whatever it holds now.", needs: "Toggle" },
  expand: { what: "Open a disclosure triangle or tree item.", needs: "Expand" },
  collapse: { what: "Close a disclosure triangle or tree item.", needs: "Collapse" },
  scroll: { what: "Move the content inside a scrollable area.", needs: "Scroll" },
  "scroll-to": { what: "Bring the element into view without changing it.", needs: null },
  hover: { what: "Move the pointer onto the element and leave it.", needs: null, headed: true },
};

const TAKES_TEXT = new Set(Object.entries(VERBS).filter(([, v]) => v.text).map(([k]) => k));
const NEEDS_HEADED = new Set(Object.entries(VERBS).filter(([, v]) => v.headed).map(([k]) => k));

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

/** A sheet, menu or alert owns input while it is up, and the window tree marks
 *  its elements offscreen. Reading the surface is the only way to act on it. */
export const overlayRole = (tree) => {
  let found = null;
  const walk = (n) => {
    if (!found && ["sheet", "alert", "menu", "popover"].includes(n.role)) found = n.role;
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return found;
};

/**
 * The only elements withheld are ones no command can reach. Everything else is
 * offered: the docs are explicit that a Choice does better with the full list
 * than a shortlist, and an unnamed row is still distinguishable by the value it
 * holds.
 *
 * An element that advertises no action is the one that must go. A sidebar
 * category in Numbers publishes its label on a cell and its behaviour on the
 * row around it, and both carry the same name, so the inert cell wins the
 * choice about half the time and every such win ends in POLICY_DENIED. Nothing
 * is lost by withholding it: the row beside it is the element that acts.
 */
export const offerable = (refs) =>
  refs.filter((n) => {
    const s = n.states ?? [];
    if (s.includes("disabled") || s.includes("hidden")) return false;
    if (!n.available_actions?.length) return false;
    return !(n.role === "cell" && n.parentRole === "treeitem");
  });

/** Structured criteria disambiguate better than a flat sentence. */
export const describe = (node, rich) => {
  const d = {
    what: `${node.role}${quoted(node.name ?? node.description)}`,
    where: node.path.length ? node.path.join(" > ") : "top level",
  };
  if (node.value != null && node.value !== "") d.holds = String(node.value).slice(0, 120);
  if (node.states?.length) d.state = node.states.join(", ");
  // A PDF form field carries no name, no description and no help text, so
  // position is the only thing that tells one from the next. Reading order and
  // "the box on the left" are answerable from it; nothing else on such a
  // screen is.
  if (!d.what.includes('"') && node.bounds) {
    d.at = `x ${Math.round(node.bounds.x)}, y ${Math.round(node.bounds.y)}`;
  }
  if (rich) {
    if (node.available_actions?.length) d.supports = node.available_actions.join(", ");
    if (node.children_count) d.contains = `${node.children_count} items not shown`;
  }
  return d;
};

export const label = (n) => `${n.role}${quoted(n.name ?? n.description)}`;

/**
 * One request carries every question. They are answered in parallel, so the
 * speculative ones cost tokens but no latency.
 */
export const buildRequest = (intent, surface, candidates, rich = false) => ({
  state: {
    intent,
    app: surface.app,
    window: surface.window,
    surface: surface.overlay ?? "window",
    element_count: candidates.length,
  },
  model: "jev-latest",
  questions: {
    target: {
      type: "choice",
      instructions: {
        task: "Which element on screen does `intent` refer to?",
        how: "Match the intent against each element's role, label, the value it holds, and where it sits. Use the containing surface to break ties between elements with the same label.",
        note: "Judge identity only. Do not consider whether the action would succeed.",
      },
      criteria: {
        ...Object.fromEntries(candidates.map((n) => [n.ref_id, describe(n, rich)])),
        [NO_MATCH]: {
          what: "None of the above",
          when: "Nothing on screen is what the intent describes. The screen is in a different state, or the element lives behind a menu or sheet that is not open.",
        },
      },
    },
    command: {
      type: "choice",
      instructions: {
        task: "Which operation does `intent` ask to perform on that element?",
        how: "Choose the operation the intent names, not the one the element most commonly receives. An intent that names a target state wants that state set, not flipped.",
        note: "When the intent only names an element and no operation, choose the operation that element plainly exists for: a button is pressed, a text field receives text, a checkbox is set.",
      },
      criteria: Object.fromEntries(Object.entries(VERBS).map(([k, v]) => [k, v.what])),
    },
    present: {
      type: "noul",
      instructions:
        "Is the thing `intent` describes actually on this screen right now, rather than somewhere the caller still has to navigate to?",
    },
    destructive: {
      type: "noul",
      instructions:
        "Would carrying out `intent` be hard or impossible to undo: deleting, overwriting, sending, purchasing, quitting without saving, or confirming a warning?",
    },
    needs_text: {
      type: "noul",
      instructions:
        "Does `intent` require the caller to supply text, rather than only pointing at an element?",
    },
  },
});

export const readAnswers = (body) => {
  const a = body?.answers;
  if (a?.target?.type !== "choice" || a?.command?.type !== "choice") {
    return { error: "response carried no target or command answer" };
  }
  return {
    target: a.target.choice,
    targetConfidence: a.target.confidence,
    probabilities: a.target.probabilities ?? {},
    command: a.command.choice,
    commandConfidence: a.command.confidence,
    present: a.present?.noul ?? null,
    destructive: a.destructive?.noul ?? null,
    needsText: a.needs_text?.noul ?? null,
  };
};

/**
 * Code corrects the verb, because target and command are answered in parallel
 * and neither can see the other. A readonly combobox that advertises Click but
 * not SetValue must not receive set-value.
 */
export const reconcile = (verb, node, hasText = false) => {
  const has = node?.available_actions ?? [];
  // The caller passing --text is evidence Jev does not have. A text payload
  // with a non-text verb means the verb is wrong, not that the text is spare.
  if (hasText && !VERBS[verb]?.text) {
    if (has.includes("SetValue")) return { verb: "set-value", corrected: true };
    if (has.includes("TypeText")) return { verb: "type", corrected: true };
  }
  const need = VERBS[verb]?.needs;
  if (!need || has.includes(need)) return { verb, corrected: false };
  if (verb === "set-value" && has.includes("TypeText")) return { verb: "type", corrected: true };
  if (verb === "type" && has.includes("SetValue")) return { verb: "set-value", corrected: true };
  const fallback = Object.entries(VERBS).find(([, v]) => v.needs && has.includes(v.needs));
  return fallback ? { verb: fallback[0], corrected: true } : { verb, corrected: false };
};

/**
 * Confidence is the second axis: the answer says what, confidence says whether
 * to act. The bar rises with how hard the action is to undo.
 */
export const route = (a, { floor = 0.55, act = 0.7, risky = 0.9 } = {}) => {
  if (a.target === NO_MATCH) return { decision: "abstain", why: "nothing on screen matches the intent" };
  if (a.present !== null && a.present < 0.3) {
    return { decision: "abstain", why: `the element is probably not on this screen (present ${a.present.toFixed(2)})` };
  }
  if (a.targetConfidence < floor) {
    return { decision: "abstain", why: `two elements fit equally well (${a.targetConfidence.toFixed(2)})` };
  }
  const dangerous = a.destructive !== null && a.destructive >= 0.5;
  const bar = dangerous ? risky : act;
  if (a.targetConfidence < bar) {
    return {
      decision: "confirm",
      why: dangerous
        ? `hard to undo (destructive ${a.destructive.toFixed(2)}) and confidence ${a.targetConfidence.toFixed(2)} is under ${risky}`
        : `confidence ${a.targetConfidence.toFixed(2)} is under ${act}`,
    };
  }
  return { decision: "act", why: null };
};

export const toArgv = (verb, ref, text) => {
  const argv = [verb, ref];
  if (verb === "scroll") argv.push("--direction", "down");
  else if (TAKES_TEXT.has(verb)) argv.push(text ?? "");
  if (NEEDS_HEADED.has(verb)) argv.unshift("--headed");
  return argv;
};

const run = (bin, argv) => {
  try {
    return JSON.parse(execFileSync(bin, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
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
  return readAnswers(await res.json());
};

// ponytail: exitCode, not exit(). process.exit() can cut off buffered stdout,
// and a tool whose JSON truncates is worse than one that fails.
const fail = (message, extra = {}) => {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exitCode = 1;
  throw new Error("__handled__");
};

const main = async (argv) => {
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? null : argv[i + 1];
  };
  const bools = new Set(["--execute", "--raw"]);
  const app = flag("app");
  const text = flag("text");
  const root = flag("root");
  const execute = argv.includes("--execute");
  const bin = flag("bin") ?? (existsSync(join(REPO, "target/release/agent-desktop"))
    ? join(REPO, "target/release/agent-desktop")
    : "agent-desktop");
  const intent = argv
    .filter((a, i) => !a.startsWith("--") && !(argv[i - 1]?.startsWith("--") && !bools.has(argv[i - 1])))
    .join(" ");

  if (!app || !intent) {
    console.error('usage: act.mjs --app <name> [--text "…"] [--root @ref] [--execute] "<intent>"');
    process.exit(2);
  }
  if (!process.env.TYPESAFE_API_KEY) fail("TYPESAFE_API_KEY unset");

  const base = ["snapshot", "--app", app, "-i", "--compact", "--include-bounds"];
  let snap = run(bin, root ? [...base, "--root", root] : base);
  if (!snap.ok) fail(`snapshot failed: ${snap.error?.code}`, { detail: snap.error?.message });

  const overlay = overlayRole(snap.data.tree);
  if (overlay && !root) {
    const surfaceSnap = run(bin, ["snapshot", "--app", app, "--surface", overlay, "-i", "--compact", "--include-bounds"]);
    if (surfaceSnap.ok) snap = surfaceSnap;
  }

  const surface = {
    app: snap.data.app ?? app,
    window: snap.data.window?.title ?? null,
    overlay,
  };
  let candidates = offerable(collect(snap.data.tree));
  if (candidates.length === 0) fail("no actionable element on screen");

  const truncated = candidates.length > MAX_OPTIONS;
  if (truncated) candidates = candidates.slice(0, MAX_OPTIONS);

  let answers = await ask(buildRequest(intent, surface, candidates));
  if (answers.error) fail(answers.error);

  // A close call gets a second, richer pass over its own top few. Cheap, and
  // the wide pass only has room for short descriptions.
  let reranked = false;
  if (answers.target !== NO_MATCH && answers.targetConfidence < RERANK_BELOW) {
    const top = Object.entries(answers.probabilities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, SHORTLIST)
      .map(([ref]) => ref)
      .filter((ref) => ref !== NO_MATCH);
    const shortlist = candidates.filter((n) => top.includes(n.ref_id));
    if (shortlist.length > 1) {
      const second = await ask(buildRequest(intent, surface, shortlist, true));
      if (!second.error) {
        answers = second;
        reranked = true;
      }
    }
  }

  const byRef = new Map(candidates.map((n) => [n.ref_id, n]));
  const node = byRef.get(answers.target);
  const { verb, corrected } = reconcile(answers.command, node, text !== null);
  const decision = route(answers);
  // Only the verb decides this. The gate is a speculative read of the intent,
  // and asking a click for text because it scored 0.50 stops an action that
  // needs no text and never could.
  const missingText = TAKES_TEXT.has(verb) && text === null;

  const out = {
    ok: true,
    intent,
    app: surface.app,
    window: surface.window,
    surface: overlay ?? "window",
    element: node
      ? { ref: node.ref_id, role: node.role, name: node.name ?? node.description ?? null, where: node.path.join(" > ") }
      : null,
    command: node ? verb : null,
    argv: node && !missingText ? toArgv(verb, node.ref_id, text) : null,
    decision: missingText ? "needs_text" : decision.decision,
    why: missingText ? `${verb} needs text; pass --text` : decision.why,
    confidence: { target: answers.targetConfidence, command: answers.commandConfidence },
    gates: { present: answers.present, destructive: answers.destructive, needs_text: answers.needsText },
    runner_up: Object.entries(answers.probabilities)
      .filter(([ref, p]) => ref !== answers.target && p >= 0.01)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([ref, p]) => ({ ref: ref === NO_MATCH ? null : ref, what: byRef.get(ref) ? label(byRef.get(ref)) : "none of the above", p })),
    notes: [
      corrected ? `command corrected to ${verb}: the element does not advertise ${answers.command}` : null,
      reranked ? "reranked over the top candidates after a close first pass" : null,
      truncated ? `screen has more than ${MAX_OPTIONS} elements; drill in with --root @ref` : null,
    ].filter(Boolean),
  };

  if (execute && out.decision === "act") {
    const result = run(bin, out.argv);
    out.executed = result.ok
      ? { ok: true, delivery: result.data?.disposition?.delivery ?? null }
      : { ok: false, code: result.error?.code, message: result.error?.message, retry: result.error?.disposition?.retry };
  } else if (execute) {
    out.executed = { ok: false, code: "NOT_EXECUTED", message: `decision was ${out.decision}` };
  }

  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.executed && !out.executed.ok ? 1 : 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((e) => {
    if (e.message === "__handled__") return;
    console.log(JSON.stringify({ ok: false, error: String(e.message ?? e) }, null, 2));
    process.exitCode = 1;
  });
}
