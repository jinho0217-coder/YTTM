const test = require("node:test");
const assert = require("node:assert/strict");
const { runReservation } = require("../scripts/library-run-state");

test("dry run does not claim or submit", async () => {
  let called = false;
  const result = await runReservation({ inspect: async () => ({ status: "ready", accountId: "a" }), claim: async () => { called = true; }, submit: async () => { called = true; }, finish: async () => { called = true; } });
  assert.equal(result.status, "dry_run");
  assert.equal(called, false);
});

test("uncertain submission is recorded and is not retried", async () => {
  let submissions = 0;
  let recorded;
  const result = await runReservation({ dryRun: false, inspect: async () => ({ status: "ready", accountId: "a" }), claim: async () => true, submit: async () => { submissions += 1; throw new Error("timeout"); }, finish: async value => { recorded = value; } });
  assert.equal(result.status, "unknown");
  assert.equal(recorded.status, "unknown");
  assert.equal(submissions, 1);
});

test("a previously claimed run is never submitted again", async () => {
  let called = false;
  const result = await runReservation({ dryRun: false, inspect: async () => ({ status: "ready", accountId: "a" }), claim: async () => false, submit: async () => { called = true; }, finish: async () => { called = true; } });
  assert.equal(result.status, "unknown");
  assert.equal(called, false);
});

test("an inspection failure is reported without submitting", async () => {
  let recorded;
  let submitted = false;
  const result = await runReservation({ dryRun: false, inspect: async () => { throw new Error("network"); }, claim: async () => true, submit: async () => { submitted = true; }, finish: async value => { recorded = value; } });
  assert.equal(result.status, "unknown");
  assert.equal(recorded.status, "unknown");
  assert.equal(submitted, false);
});
