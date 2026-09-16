import assert from "node:assert/strict";
import { buildActions, buildRequest, collect, decide, isReachable, stopReason } from "./loop.mjs";

const SNAP = "s8f3k2p9";
const tree = {
  role: "window",
  name: "Untitled",
  children: [
    { ref_id: `@${SNAP}:e1`, role: "textfield", name: "Save As:", value: "Untitled.rtf", available_actions: ["SetValue"] },
    { ref_id: `@${SNAP}:e2`, role: "combobox", name: "File Format:", value: "Rich Text", states: ["readonly"], available_actions: ["Click"] },
    { ref_id: `@${SNAP}:e3`, role: "button", name: "Save", available_actions: ["Click"] },
    { ref_id: `@${SNAP}:e4`, role: "button", name: "Old Save", states: ["offscreen"], available_actions: ["Click"] },
    { ref_id: `@${SNAP}:e5`, role: "button", name: "Open", states: ["disabled"], available_actions: ["Click"] },
    { ref_id: `@${SNAP}:e6`, role: "checkbox", name: "Hide extension", available_actions: ["Click", "Toggle"] },
    { ref_id: `@${SNAP}:e7`, role: "scrollarea", available_actions: ["Scroll"] },
  ],
};

const refs = collect(tree);
assert.equal(refs.length, 7);
assert.deepEqual(refs[0].path, ['window "Untitled"']);

// The safety gate drops what the loop must never offer.
assert.ok(isReachable(refs[2]));
assert.ok(!isReachable(refs[3]));
assert.ok(!isReachable(refs[4]));

const actions = buildActions(refs, { name: "poem.txt" });
const keys = actions.map((a) => a.key);
assert.ok(!keys.some((k) => k.endsWith("_e4")), "offscreen element must not be offered");
assert.ok(!keys.some((k) => k.endsWith("_e5")), "disabled element must not be offered");
assert.equal(new Set(keys).size, keys.length, "keys must be unique");

// An element only contributes verbs it advertises. The readonly combobox
// advertises Click and not SetValue, so no set action can reach the choice --
// this is the failure that stalled the manual run.
assert.ok(keys.includes("click_e2"));
assert.ok(!keys.includes("set_e2_name"));
assert.deepEqual(
  actions.find((a) => a.key === "set_e1_name").argv,
  ["set-value", `@${SNAP}:e1`, "poem.txt"],
);
assert.ok(actions.find((a) => a.key === "set_e1_name").label.includes('replacing "Untitled.rtf"'));
assert.deepEqual(actions.find((a) => a.key === "toggle_e6").argv, ["toggle", `@${SNAP}:e6`]);
assert.deepEqual(actions.find((a) => a.key === "scroll_e7_down").argv, [
  "scroll",
  `@${SNAP}:e7`,
  "--direction",
  "down",
]);

// Key combos are always offered and carry no ref.
assert.deepEqual(actions.find((a) => a.key === "press_cmd+s").argv, ["press", "cmd+s"]);

// A scrollbar handle advertises SetValue too; it must never be a text target.
const withHandle = collect({ role: "window", children: [{ ref_id: "@s:e9", role: "handle", value: "0", available_actions: ["SetValue"] }] });
assert.ok(!buildActions(withHandle, { name: "poem.txt" }).some((a) => a.key.startsWith("set_")));

// With no supplied values there is no way to enter text at all.
assert.ok(!buildActions(refs, {}).some((a) => a.key.startsWith("set_")));

const req = buildRequest("save the file", { app: "TextEdit", window: "Untitled" }, actions, []);
assert.deepEqual(Object.keys(req.questions), ["next_action", "goal_complete", "needs_human"]);
assert.equal(req.questions.goal_complete.type, "noul");
assert.deepEqual(Object.keys(req.questions.next_action.criteria).sort(), keys.sort());

const answer = (over = {}) =>
  decide({
    answers: {
      next_action: { type: "choice", choice: "click_e3", confidence: 0.9 },
      goal_complete: { type: "noul", noul: 0.05 },
      needs_human: { type: "noul", noul: 0.02 },
      ...over,
    },
  });
assert.equal(answer().key, "click_e3");
assert.equal(answer().done, 0.05);
assert.ok(decide({}).error);

// Policy stops before the chosen action ever runs.
assert.equal(stopReason(answer()), null);
assert.match(stopReason(answer({ goal_complete: { type: "noul", noul: 0.8 } })), /goal complete/);
assert.match(stopReason(answer({ needs_human: { type: "noul", noul: 0.6 } })), /needs a person/);
assert.match(
  stopReason(answer({ next_action: { type: "choice", choice: "click_e3", confidence: 0.3 } })),
  /unsure/,
);

console.log("ok");
