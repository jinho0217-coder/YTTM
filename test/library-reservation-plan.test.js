const test = require("node:test");
const assert = require("node:assert/strict");
const { planReservation } = require("../scripts/library-reservation-plan");

const request = { date: "2026-11-08", startHour: 13, duration: 1, accounts: [{ id: "a", enabled: true, consent: true }, { id: "b", enabled: true, consent: true }], history: [], verifiedAccounts: ["a", "b"] };

test("an already approved slot is reported as a success without booking again", () => {
  const history = [{ accountId: "a", date: request.date, startHour: 13, endHour: 14, status: "approved" }];
  assert.equal(planReservation({ ...request, history }).status, "success");
});

test("selects an eligible account and skips accounts at the monthly limit", () => {
  const history = [{ accountId: "a", date: "2026-11-01", startHour: 10, endHour: 14, status: "approved" }];
  assert.deepEqual(planReservation({ ...request, history }), { status: "ready", accountId: "b" });
});

test("stops when a reservation overlaps or history cannot be trusted", () => {
  const overlapping = [{ accountId: "a", date: "2026-11-08", startHour: 13, endHour: 14, status: "pending" }];
  assert.equal(planReservation({ ...request, history: overlapping }).status, "unknown");
  assert.equal(planReservation({ ...request, history: [{ ...overlapping[0], status: "unexpected" }] }).status, "unknown");
});

test("does not select accounts without owner consent", () => {
  assert.equal(planReservation({ ...request, accounts: [{ id: "a", enabled: true, consent: false }] }).status, "failed");
});

test("does not proceed when any enabled account history was not verified", () => {
  assert.equal(planReservation({ ...request, verifiedAccounts: ["a"] }).status, "unknown");
});
