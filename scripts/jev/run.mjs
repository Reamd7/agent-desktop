#!/usr/bin/env node
/**
 * jev-desktop: one goal in, a desktop driven to it.
 *
 *   node scripts/jev/run.mjs --app Finder "open the Applications folder"
 *
 * The caller states a goal once. Each turn reads the live accessibility tree,
 * asks for one operation and a target for that operation, carries it out, and
 * reads again. The tree never reaches the caller.
 */
import { fileURLToPath } from "node:url";

import { describe } from "./act.mjs";
import { cli, execute, observe, startCursor, stopCursor } from "./desktop.mjs";
import {
  actionSpace,
  buildRequest,
  criterion,
  fingerprint,
  shouldStop,
  textSupply,
  validateChoice,
  TERMINALS,
} from "./policy.mjs";

const API = "https://api.typesafe.ai/v1/systemone";

const post = async (url, key, body) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res) throw new Error("the model could not be reached; nothing ran");
    if ([429, 503, 529].includes(res.status) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`the model returned HTTP ${res.status}; nothing ran. ${detail.slice(0, 400)}`);
    }
    return res.json();
  }
  throw new Error("the model stayed unavailable");
};

export const run = async function* (goal, app, { root = null, text = null, cursor = false } = {}) {
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY unset");
  const supply = textSupply(text);
  const session = cursor ? startCursor(goal) : null;
  const clipboard = cli("clipboard-get");
  const state = { steps: 0, calls: 0, history: [], operation: null, root };
  try {
    for (;;) {
      const { nodes, screen } = observe(app, state.root);
      const before = fingerprint(nodes);
      const space = actionSpace(nodes, { drillable: !state.root, typable: supply.available() });
      if (!space.elements.length) {
        yield { stop: "nothing on this screen can be acted on", screen };
        return;
      }
      const answers = (await post(API, process.env.TYPESAFE_API_KEY, buildRequest(goal, screen, space, state.history)))
        .answers;
      state.calls += 1;
      const options = [
        ...Object.keys(space.targets),
        ...(state.root ? ["WIDEN"] : []),
        ...Object.keys(TERMINALS),
      ];
      state.operation = validateChoice(answers.operation, options).choice;
      const stop = shouldStop(state);
      if (stop) {
        yield {
          stop,
          screen,
          why: answers.operation.probabilities,
          confidence: answers.operation.confidence,
          history: state.history,
        };
        return;
      }
      let node = null;
      let confidence = answers.operation.confidence;
      if (space.targets[state.operation]) {
        const head = validateChoice(
          answers[`${state.operation.toLowerCase()}_target`],
          Object.keys(space.targets[state.operation]),
        );
        node = space.targets[state.operation][head.choice];
        confidence = head.confidence;
      }
      let value = null;
      if (state.operation === "TYPE_TEXT") {
        value = await supply.take(describe(node, true), state.history);
        if (typeof value !== "string" || !value.trim()) {
          yield { stop: `no value was supplied for ${criterion(node, "?")}`, screen, history: state.history };
          return;
        }
      }
      const outcome = execute(app, state.operation, node, value);
      state.steps += 1;
      const turn = {
        step: state.steps,
        operation: state.operation,
        target: node ? `${node.role}${node.name ? ` "${node.name}"` : ""}` : null,
        ref: node?.ref_id ?? null,
        text: value,
        confidence,
        ok: outcome.ok,
        delivery: outcome.delivery,
        route: outcome.route ?? null,
        changed: null,
      };
      state.history.push(turn);
      if ("root" in outcome) state.root = outcome.root;
      turn.changed = "root" in outcome || fingerprint(observe(app, state.root).nodes) !== before;
      yield { turn, screen };
      const settled = shouldStop(state);
      if (settled) {
        yield { stop: settled, screen, history: state.history };
        return;
      }
    }
  } finally {
    const previous = clipboard.data?.text;
    if (typeof previous === "string") cli("clipboard-set", previous);
    if (session) stopCursor();
  }
};

const main = async (argv) => {
  const flag = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? null : argv[at + 1];
  };
  const app = flag("app");
  const root = flag("root");
  const text = argv.flatMap((a, i) => (argv[i - 1] === "--text" ? [a] : []));
  const cursor = argv.includes("--cursor");
  const goal = argv
    .filter((a, i) => !a.startsWith("--") && !(argv[i - 1]?.startsWith("--") && argv[i - 1] !== "--cursor"))
    .join(" ");
  if (!app || !goal) {
    console.error('usage: run.mjs --app <name> [--cursor] [--root @ref] [--text "value"]... "<goal>"');
    process.exit(2);
  }
  for await (const event of run(goal, app, { root, text, cursor })) console.log(JSON.stringify(event));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((error) => {
    console.log(JSON.stringify({ ok: false, error: String(error.message ?? error) }));
    process.exitCode = 1;
  });
}
