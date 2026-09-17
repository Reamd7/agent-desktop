import assert from "node:assert/strict";
import { collect, offerable } from "./act.mjs";
import {
  ARGV,
  OPS,
  actionSpace,
  buildRequest,
  criterion,
  fingerprint,
  shouldStop,
  textSupply,
  validateChoice,
} from "./policy.mjs";

const S = "s8f3k2p9";
const screen = (extra = []) =>
  offerable(
    collect({
      role: "window",
      name: "Untitled",
      children: [
        { ref_id: `@${S}:e1`, role: "button", name: "Save", available_actions: ["Click"] },
        { ref_id: `@${S}:e2`, role: "textfield", name: "Name", available_actions: ["SetValue", "Click"] },
        { ref_id: `@${S}:e3`, role: "checkbox", name: "Remember me", available_actions: ["Toggle", "Click"] },
        { ref_id: `@${S}:e4`, role: "scrollarea", available_actions: ["Scroll"] },
        { ref_id: `@${S}:e5`, role: "statictext", name: "inert", available_actions: [] },
        ...extra,
      ],
    }),
  );

const space = actionSpace(screen());

{
  assert.ok(!space.elements.some((line) => line.includes("inert")), "an element that advertises nothing is never offered");
  assert.deepEqual(Object.keys(space.targets).sort(), ["CHECK", "CLICK", "SCROLL", "TYPE_TEXT", "UNCHECK"]);
}

{
  assert.equal(criterion({ role: "button", name: "Save" }, "1"), '[1] button "Save"');
  assert.equal(
    criterion({ role: "textfield", value: "Jane", states: ["focused"] }, "2"),
    '[2] textfield · holds "Jane" · focused',
  );
  assert.equal(
    criterion({ role: "cell", bounds: { x: 281.4, y: 376.2 } }, "9"),
    "[9] cell · at 281,376",
    "an element with nothing to say for itself is told apart by where it sits",
  );
  assert.ok(
    !criterion({ role: "button", name: "Save", bounds: { x: 10, y: 20 } }, "1").includes("at "),
    "position is spent only where a name and a value are both missing",
  );
}

{
  const clickable = Object.values(space.targets.CLICK).map((n) => n.ref_id);
  assert.ok(!clickable.includes(`@${S}:e4`), "a scroll area advertises no Click and is not a click target");
  const typable = Object.values(space.targets.TYPE_TEXT).map((n) => n.ref_id);
  assert.deepEqual(typable, [`@${S}:e2`], "only a field that advertises SetValue can receive text");
  for (const [operation, targets] of Object.entries(space.targets)) {
    for (const node of Object.values(targets)) {
      assert.ok(
        node.available_actions.includes(OPS[operation].needs),
        `every ${operation} target advertises ${OPS[operation].needs}, so the verb can never mismatch the element`,
      );
    }
  }
}

{
  const checkbox = Object.values(space.targets.CHECK)[0];
  assert.equal(checkbox.ref_id, `@${S}:e3`);
  assert.deepEqual(ARGV.CHECK(checkbox.ref_id), ["check", checkbox.ref_id]);
  assert.deepEqual(ARGV.UNCHECK(checkbox.ref_id), ["uncheck", checkbox.ref_id]);
  assert.ok(!("TOGGLE" in OPS), "check and uncheck are idempotent, so a state the goal already wants stays put");
}

{
  const request = buildRequest("save the file", { app: "TextEdit", window: "Untitled" }, space, []);
  assert.deepEqual(
    Object.keys(request.questions).sort(),
    [
      "check_target",
      "click_target",
      "destructive",
      "operation",
      "scroll_target",
      "type_text_target",
      "uncheck_target",
    ],
    "one target head per offered operation, asked in the same request as the operation",
  );
  assert.equal(request.questions.destructive.type, "noul", "how hard the step is to undo is asked in that same request");
  for (const terminal of ["WAIT", "DONE", "BLOCKED"]) {
    assert.ok(terminal in request.questions.operation.criteria);
    assert.ok(!(`${terminal.toLowerCase()}_target` in request.questions), "a terminal operation has no target head");
  }
}

{
  const good = { choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 0.9, DONE: 0.1 } };
  assert.equal(validateChoice(good, ["CLICK", "DONE"]).choice, "CLICK");
  assert.throws(() => validateChoice(good, ["DONE"]), /offered option/, "a choice outside the offer never runs");
  assert.throws(
    () => validateChoice({ choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 0.4 } }, ["CLICK"]),
    /offered option/,
    "probabilities that do not sum to one are not an answer",
  );
  assert.throws(() => validateChoice(undefined, ["CLICK"]), /offered option/);
}

{
  const nodes = screen();
  assert.equal(fingerprint(nodes), fingerprint(screen()), "the same screen reads the same");
  const changed = screen([{ ref_id: `@${S}:e9`, role: "button", name: "New", available_actions: ["Click"] }]);
  assert.notEqual(fingerprint(nodes), fingerprint(changed), "a screen that gained a control reads differently");
}

{
  const stalled = { steps: 3, calls: 3, operation: "CLICK", history: Array(3).fill({ changed: false, operation: "CLICK" }) };
  assert.match(shouldStop(stalled), /changed nothing/);
  const waiting = { steps: 3, calls: 3, operation: "WAIT", history: Array(3).fill({ changed: false, operation: "WAIT" }) };
  assert.equal(shouldStop(waiting), null, "waiting is allowed to change nothing; that is what it is for");
  assert.equal(shouldStop({ steps: 1, calls: 1, operation: "DONE", history: [] }), "done");
  assert.equal(shouldStop({ steps: 1, calls: 1, operation: "BLOCKED", history: [] }), "blocked");
  assert.match(shouldStop({ steps: 40, calls: 1, operation: "CLICK", history: [] }), /action budget/);
  assert.match(shouldStop({ steps: 1, calls: 80, operation: "CLICK", history: [] }), /model call budget/);
  assert.equal(shouldStop({ steps: 1, calls: 1, operation: "CLICK", history: [] }), null);
}

{
  const list = textSupply(["first", "second"]);
  assert.equal(list.available(), true);
  assert.equal(await list.take(), "first");
  assert.equal(await list.take(), "second");
  assert.equal(list.available(), false, "an exhausted list stops offering to type");
  assert.equal(await list.take(), null, "and never invents one more value");

  const one = textSupply("only");
  assert.equal(await one.take(), "only");
  assert.equal(one.available(), false);

  const asked = [];
  const fn = textSupply((field) => {
    asked.push(field.what);
    return "from the caller";
  });
  assert.equal(fn.available(), true, "a caller that answers per field is never exhausted");
  assert.equal(await fn.take({ what: 'textfield "Name"' }), "from the caller");
  assert.deepEqual(asked, ['textfield "Name"'], "the field is described to the caller before it answers");

  assert.equal(textSupply(null).available(), false, "no supply means typing is never offered");
}

{
  const withoutText = actionSpace(screen(), { typable: false });
  assert.ok(!("TYPE_TEXT" in withoutText.targets), "with nothing to type, the operation is not offered at all");
  assert.ok("CLICK" in withoutText.targets, "everything else stays on offer");
}

{
  const dense = Array.from({ length: 300 }, (_, i) => ({
    ref_id: `@${S}:d${i}`,
    role: "button",
    name: `Button ${i}`,
    available_actions: ["Click"],
  }));
  const full = actionSpace(dense);
  assert.equal(full.elements.length, 254, "a choice takes no more options than that");
  assert.equal(full.truncated, true, "and the run is told that something was left out");
  assert.match(
    buildRequest("do it", { app: "X", window: "Y" }, full, []).questions.operation.instructions.rules,
    /prefer DRILL/,
    "so it looks inside a region instead of calling the goal impossible",
  );
  assert.equal(actionSpace(screen()).truncated, false, "a screen that fits says so");
}

{
  const node = { role: "textfield", name: "Card", value: "4111 1111 1111 1111" };
  assert.match(criterion(node, "1"), /4111/, "a value is described by default, which is how a target is told apart");
  assert.doesNotMatch(
    criterion(node, "1", { values: false }),
    /4111/,
    "and withheld on request, so a private field never leaves the machine",
  );
  const withheld = actionSpace([{ ...node, ref_id: "@s:e1", available_actions: ["SetValue"] }], { values: false });
  assert.doesNotMatch(withheld.elements.join(" "), /4111/);
}

console.log("ok");
