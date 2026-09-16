import assert from "node:assert/strict";
import { buildRequest, candidatesFor, collect, describe, isDistinct, isReachable, overlayRole, readAnswer, toArgv } from "./run.mjs";

const S = "s8f3k2p9";
const sheet = collect({
  role: "window",
  name: "Untitled",
  children: [
    { ref_id: `@${S}:e1`, role: "textfield", name: "Save As:", value: "Untitled.rtf", available_actions: ["SetValue"] },
    { ref_id: `@${S}:e2`, role: "combobox", name: "File Format:", value: "Rich Text", states: ["readonly"], available_actions: ["Click"] },
    { ref_id: `@${S}:e3`, role: "button", name: "Save", available_actions: ["Click"] },
    { ref_id: `@${S}:e4`, role: "button", name: "Old", states: ["disabled"], available_actions: ["Click"] },
    { ref_id: `@${S}:e5`, role: "treeitem", name: "Documents", available_actions: ["Click"],
      children: [{ ref_id: `@${S}:e6`, role: "cell", name: "Documents", available_actions: ["Click"] }] },
  ],
});

assert.equal(sheet.length, 6);
assert.deepEqual(sheet[0].path, ['window "Untitled"']);
assert.ok(!isReachable(sheet[3]), "a disabled element is never a candidate");

// The verb decides the candidate set, so a step can only ever hit an element
// that supports it. The readonly combobox advertises Click and not SetValue.
assert.deepEqual(candidatesFor(sheet, "set-value").map((n) => n.ref_id), [`@${S}:e1`]);
assert.deepEqual(
  candidatesFor(sheet, "click").map((n) => n.ref_id),
  [`@${S}:e2`, `@${S}:e3`, `@${S}:e5`],
);
assert.ok(!candidatesFor(sheet, "click").some((n) => n.role === "cell"), "a cell repeats its treeitem");

// A TextEdit document body is an unnamed textfield; requiring a name dropped
// the one element that mattered.
const doc = collect({
  role: "window",
  children: [
    { ref_id: "@s:e1", role: "textfield", available_actions: ["TypeText"] },
    { ref_id: "@s:e2", role: "combobox", name: "font size", value: "12", available_actions: ["SetValue"] },
  ],
});
assert.ok(isDistinct(doc[0], doc));
assert.deepEqual(candidatesFor(doc, "set-value").map((n) => n.ref_id), ["@s:e1", "@s:e2"]);
assert.ok(describe(doc[0]).includes("only one of its kind"));

// Two unnamed rows of the same role cannot be told apart, so neither is offered.
const rows = collect({
  role: "list",
  children: [
    { ref_id: "@s:e1", role: "textfield", value: "a.rtf", available_actions: ["Click"] },
    { ref_id: "@s:e2", role: "textfield", value: "b.rtf", available_actions: ["Click"] },
  ],
});
assert.equal(candidatesFor(rows, "click").length, 0);

assert.equal(overlayRole({ role: "window", children: [{ role: "group" }] }), null);
assert.equal(overlayRole({ role: "window", children: [{ role: "group", children: [{ role: "sheet" }] }] }), "sheet");

const req = buildRequest({ verb: "set-value", target: "the name field" }, { app: "TextEdit", window: "Untitled" }, candidatesFor(sheet, "set-value"));
assert.deepEqual(Object.keys(req.questions), ["target"]);
assert.deepEqual(Object.keys(req.questions.target.criteria), [`@${S}:e1`, "none"]);
assert.equal(req.state.verb, "set-value");

assert.equal(readAnswer({ answers: { target: { type: "choice", choice: `@${S}:e1`, confidence: 0.9 } } }).id, `@${S}:e1`);
assert.ok(readAnswer({}).error);

// Qualified refs carry a colon; it must reach argv untouched.
assert.deepEqual(toArgv({ verb: "click" }, `@${S}:e3`, {}), ["click", `@${S}:e3`]);
assert.deepEqual(toArgv({ verb: "set-value", value: "name" }, `@${S}:e1`, { name: "poem.txt" }), [
  "set-value",
  `@${S}:e1`,
  "poem.txt",
]);
assert.deepEqual(toArgv({ verb: "scroll" }, `@${S}:e1`, {}), ["scroll", `@${S}:e1`, "--direction", "down"]);

console.log("ok");
