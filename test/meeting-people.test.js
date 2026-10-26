const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
function client() {
  const context = vm.createContext({ window: {}, console, Date, Intl });
  vm.runInContext(read("public/meeting-people.js"), context);
  vm.runInContext(read("public/role-suggestions.js"), context);
  const app = read("public/app.js");
  vm.runInContext(app.slice(0, app.indexOf('document.getElementById("memberFilter").addEventListener')), context);
  return context;
}
test("tentative names preserve identity and never count as confirmed", () => {
  const c = client();
  assert.equal(c.normalizeName("◷ Jin"), "Jin");
  assert.equal(c.normalizeName("◷ Shilry"), "Shirly");
  assert.equal(c.confirmedAssignment("◷ Jin"), false);
  assert.equal(c.confirmedAssignment("Jin"), true);
  assert.equal(c.confirmedAssignment(""), false);
  assert.equal(c.assignmentName("◷ Jin"), "Jin");
});
test("attendees merge aliases and multiple roles, keep guests without roles, and isolate meeting dates", () => {
  const c = client();
  const rows = [["Date", "2099-01-01", "2099-01-08"], ["Chairperson", "◷ Jin", "Other"], ["Speaker 1", "Jin", ""], ["Timer", "Shilry", ""], ["Attendees", JSON.stringify([{ name: "Guest", guest: true }, { name: "Shirly", guest: true }]), ""]];
  const model = c.buildModel(rows, []);
  const people = c.meetingAttendees(model, model.columns[0]);
  assert.equal(people.length, 3);
  const jin = people.find(p => p.name === "Jin");
  assert.equal(jin.roles.length, 2);
  assert.equal(jin.roles[0].tentative, true);
  assert.equal(people.find(p => p.name === "Shirly").guest, true);
  assert.equal(people.find(p => p.name === "Guest").roles.length, 0);
  assert.equal(c.meetingAttendees(model, model.columns[1]).length, 1);
  assert.equal(c.meetingAttendees(model, { ...model.columns[0], noMeeting: true }).length, 0);
});
test("a new attendees row survives shared snapshots and pending local overlays", () => {
  const c = client();
  const rows = [["Date", "2099-01-01", "2099-01-08"], ["Chairperson", "Jin", ""]];
  c.applySharedDraftsToRows(rows, { meetings: { "2099-01-01": { attendees: { Attendees: '[{"name":"Guest","guest":true}]' } } } });
  c.applySharedDraftsToRows(rows, { meetings: { "2099-01-08": { attendees: { Attendees: '[{"name":"Next","guest":false}]' } } } });
  assert.equal(rows.filter(r => r[0] === "Attendees").length, 1);
  assert.match(rows[2][1], /Guest/);
  assert.match(rows[2][2], /Next/);
});

function service() {
  const properties = new Map(), operations = new Map();
  const values = [["Date", "2099-01-01", "2099-01-08"], ["Chairperson", "Jin", "Other"]];
  const sheet = {
    getDataRange: () => ({ getValues: () => values }),
    getLastRow: () => values.length,
    getMaxRows: () => 1000,
    getRange: (row, col) => ({
      getValue: () => values[row - 1]?.[col - 1] || "",
      setValue: value => { values[row - 1] ||= []; values[row - 1][col - 1] = value; },
    }),
  };
  const context = vm.createContext({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }), flush() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key), setProperty: (key, val) => properties.set(key, val), deleteProperty: key => properties.delete(key) }) },
    Utilities: { formatDate: (_, __, pattern) => ({ EEE: "Mon", H: "10", "yyyy-MM-dd": "2026-10-26" })[pattern], newBlob: value => ({ getBytes: () => Buffer.from(value) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: key => operations.get(key), put: (key, val) => operations.set(key, val) }) },
    ContentService: { createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }), MimeType: { JSON: "json" } },
  });
  vm.runInContext(read("apps-script/Code.gs"), context);
  return { context, values, post: body => context.doPost({ postData: { contents: JSON.stringify(body) } }) };
}
test("attendee drafts wait for administrator approval and create only one row for multiple meetings", () => {
  const s = service();
  const value = JSON.stringify([{ name: "Guest", guest: true }]);
  let saved;
  for (const date of ["2099-01-01", "2099-01-08"]) {
    saved = s.post({ action: "saveDraft", meetingDate: date, section: "attendees", updates: { Attendees: value }, baseValues: { Attendees: "" }, fieldVersions: { Attendees: 0 } });
    assert.equal(saved.ok, true);
  }
  assert.equal(s.values.length, 2, "saving a draft cannot modify Sheets");
  const result = s.post({ action: "applyDrafts", pin: "1004", draftRevision: saved.revision, totalDrafts: 2, selectionMode: "explicit", selections: ["2099-01-01", "2099-01-08"].map(meetingDate => ({ meetingDate, section: "attendees", label: "Attendees" })) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.updated, 2);
  assert.equal(s.values.length, 3);
  assert.equal(s.values[2][0], "Attendees");
  assert.equal(s.values[2][1], value);
  assert.equal(s.values[2][2], value);
});
test("attendee validation rejects malformed, duplicate, and overlong names", () => {
  const { context } = service();
  for (const value of ['{}', '[{"name":"Guest"}]', JSON.stringify([{ name: "A", guest: false }, { name: "a", guest: true }]), JSON.stringify([{ name: "x".repeat(81), guest: true }])]) {
    assert.throws(() => context.validatedUpdates("attendees", { Attendees: value }));
  }
});
test("concurrent attendee edits cannot silently replace a newer shared list", () => {
  const s = service();
  const payload = { action: "saveDraft", meetingDate: "2099-01-01", section: "attendees", updates: { Attendees: '[{"name":"First","guest":false}]' }, baseValues: { Attendees: "" }, fieldVersions: { Attendees: 0 } };
  assert.equal(s.post(payload).ok, true);
  assert.equal(s.post({ ...payload, updates: { Attendees: "" } }).code, "DRAFT_CHANGED");
});

test("suggestions favor new roles and never replace existing assignments or duplicate people", () => {
  const c = client();
  const rows = [["Date", "2020-01-01", "2099-01-01"], ["Chairperson", "Alice", ""], ["Timer", "Bob", ""], ["Toastmaster", "Carol", "Carol"], ["Speaker 1", "Dan", "Dan"]];
  const model = c.buildModel(rows, []);
  const suggestion = c.suggestMeetingRoles(model, model.columns[1]);
  assert.equal(suggestion.items.length, 2);
  assert.equal(suggestion.items.find(item => item.label === 'Chairperson').name, 'Bob');
  assert.equal(suggestion.items.find(item => item.label === 'Timer').name, 'Alice');
  assert.ok(suggestion.items.every(item => item.count === 0));
  assert.equal(new Set(suggestion.items.map(item => item.name)).size, suggestion.items.length);
});
test("suggestions exclude guests and do not invent candidates when there is no attendance history", () => {
  const c = client();
  const rows = [["Date", "2020-01-01", "2099-01-01"], ["Chairperson", "Alice", ""], ["Timer", "Guest", ""], ["Attendees", '[{"name":"Guest","guest":true}]', ""]];
  const model = c.buildModel(rows, []);
  const suggestion = c.suggestMeetingRoles(model, model.columns[1]);
  assert.equal(suggestion.items.length, 1);
  assert.equal(suggestion.items[0].name, 'Alice');
  const empty = c.buildModel([["Date", "2099-01-01"], ["Chairperson", ""]], []);
  assert.equal(c.suggestMeetingRoles(empty, empty.columns[0]).items.length, 0);
});
