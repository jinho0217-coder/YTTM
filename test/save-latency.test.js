const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const backend = fs.readFileSync(path.join(__dirname, "../apps-script/Code.gs"), "utf8");

function draftService({ writable = false } = {}) {
  const properties = new Map();
  const operations = new Map();
  let sheetReads = 0;
  let today = "2026-10-26";
  const values = [["Date", "2099-01-01"], ["Theme", "Original"], ["Theme Question", "Question"]];
  const sheet = {
    getDataRange: () => ({ getValues: () => { sheetReads++; return values; } }),
    getRange: (row, column) => {
      if (!writable) throw new Error("Unexpected per-cell sheet request");
      return { getValue: () => values[row - 1][column - 1], setValue: value => { values[row - 1][column - 1] = value; } };
    },
  };
  const context = vm.createContext({
    SpreadsheetApp: { flush() {}, openById: () => ({ getSheetByName: () => sheet }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key),
      deleteProperty: key => properties.delete(key),
      getProperties: () => Object.fromEntries(properties),
      setProperty: (key, value) => properties.set(key, value),
      setProperties: entries => {
        for (const [key, value] of Object.entries(entries)) {
          assert.ok(Buffer.byteLength(value) <= 9000);
          properties.set(key, value);
        }
      },
    }) },
    Utilities: {
      formatDate: (_, __, pattern) => ({ EEE: "Mon", H: "10", "yyyy-MM-dd": today })[pattern],
      newBlob: value => ({ getBytes: () => Buffer.from(value) }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: key => operations.get(key), put: (key, value) => operations.set(key, value) }) },
    ContentService: { createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }), MimeType: { JSON: "json" } },
  });
  vm.runInContext(backend, context);
  const save = overrides => context.doPost({ postData: { contents: JSON.stringify({
    action: "saveDraft", meetingDate: "2099-01-01", section: "theme",
    updates: { Theme: "Saved", "Theme Question": "New question" },
    baseValues: { Theme: "Original", "Theme Question": "Question" },
    ...overrides,
  }) } });
  const post = request => context.doPost({ postData: { contents: JSON.stringify(request) } });
  return { save, post, values, properties, setToday: date => { today = date; }, readDrafts: context.readDrafts, get sheetReads() { return sheetReads; } };
}

test("a legacy draft near the old size limit migrates without losing data or field versions", () => {
  const service = draftService();
  const existing = "한글😀".repeat(750);
  const key = "2099-01-01|theme|Theme";
  service.properties.set("YTTM_SHARED_DRAFTS", JSON.stringify({
    revision: 12, meetings: { "2099-01-01": { attendees: { Attendees: existing } } },
    fieldVersions: { [key]: 4 },
  }));
  const result = service.save({ updates: { Theme: "한".repeat(500) }, fieldVersions: { Theme: 4 } });
  assert.equal(result.ok, true);
  assert.equal(result.revision, 13);
  const stored = service.readDrafts();
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) > 8800);
  assert.equal(stored.meetings["2099-01-01"].attendees.Attendees, existing);
  assert.equal(stored.meetings["2099-01-01"].theme.Theme, "한".repeat(500));
  assert.equal(stored.fieldVersions[key], 5);
});

test("multi-field draft save reads the sheet once and returns its persisted snapshot", () => {
  const service = draftService();
  const result = service.save();
  assert.equal(result.ok, true);
  assert.equal(result.updated, 2);
  assert.equal(service.sheetReads, 1);
  assert.equal(result.drafts.meetings["2099-01-01"].theme.Theme, "Saved");
  assert.equal(result.drafts.revision, result.revision);
});

test("batched reads retain sheet and draft conflict protection", () => {
  const changedSheet = draftService().save({ baseValues: { Theme: "Outdated" } });
  assert.equal(changedSheet.code, "SHEET_CHANGED");
  const service = draftService();
  assert.equal(service.save().ok, true);
  assert.equal(service.save().code, "DRAFT_CHANGED");
});

test("a confirmed field can be edited again immediately with its current version", () => {
  const service = draftService();
  const first = service.save();
  const versions = Object.fromEntries(Object.entries(first.fieldVersions).map(([key, value]) => [key.split("|")[2], value]));
  const second = service.save({ updates: { Theme: "Edited again" }, fieldVersions: versions });
  assert.equal(second.ok, true);
  assert.equal(second.drafts.meetings["2099-01-01"].theme.Theme, "Edited again");
  assert.deepEqual(second.drafts.locks, {});
  assert.equal(service.save().code, "DRAFT_CHANGED", "stale editors remain blocked by versions");
});

test("cooldowns persisted by older deployments no longer block editing", () => {
  const service = draftService();
  service.properties.set("YTTM_SHARED_DRAFTS", JSON.stringify({
    revision: 0, meetings: {}, locks: { "2099-01-01": { theme: { Theme: Date.now() + 60000 } } },
  }));
  const result = service.save();
  assert.equal(result.ok, true);
  assert.deepEqual(result.drafts.locks, {});
});

test("a sheet conflict retains the existing shared draft and its revision", () => {
  const service = draftService();
  const original = service.save();
  service.values[1][1] = "Changed in Google Sheets";
  const failure = service.save({ updates: { Theme: "Another edit" }, fieldVersions: { Theme: 1 } });
  assert.equal(failure.code, "SHEET_CHANGED");
  assert.equal(service.readDrafts().revision, original.revision);
  assert.equal(service.readDrafts().meetings["2099-01-01"].theme.Theme, "Saved");
});

test("approval writes only selected changes and keeps unchecked drafts for later", () => {
  const service = draftService({ writable: true });
  const meetingDate = "2099-01-01";
  const saved = service.save();
  const request = {
    action: "applyDrafts", pin: "1004", draftRevision: saved.revision,
    totalDrafts: 2, selectionMode: "explicit",
  };
  const empty = service.post({ ...request, selections: [] });
  assert.equal(empty.ok, false);
  assert.equal(service.readDrafts().revision, saved.revision);

  const partial = service.post({ ...request, selections: [{ meetingDate, section: "theme", label: "Theme" }] });
  assert.equal(partial.ok, true, partial.error);
  assert.equal(partial.updated, 1);
  assert.equal(partial.remaining, 1);
  assert.equal(service.values[1][1], "Saved");
  assert.equal(service.values[2][1], "Question");
  const pending = service.readDrafts();
  assert.equal(Object.hasOwn(pending.meetings[meetingDate].theme, "Theme"), false);
  assert.equal(pending.meetings[meetingDate].theme["Theme Question"], "New question");
  assert.equal(pending.bases[meetingDate].theme["Theme Question"], "Question");

  service.values[0].push("2099-01-08");
  service.setToday("2099-01-15");
  const final = service.post({
    ...request, draftRevision: partial.revision, totalDrafts: 1,
    selections: [{ meetingDate, section: "theme", label: "Theme Question" }],
  });
  assert.equal(final.ok, true, final.error);
  assert.equal(final.remaining, 0);
  assert.equal(service.values[2][1], "New question");
});

test("reloading or retrying the same save ID does not commit it twice", () => {
  const service = draftService();
  const first = service.save({ requestId: "persisted_save_123" });
  const repeated = service.save({ requestId: "persisted_save_123" });
  assert.deepEqual(repeated, first);
  assert.equal(service.sheetReads, 1);
});
