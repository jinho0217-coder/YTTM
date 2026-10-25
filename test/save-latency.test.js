const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const frontend = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const backend = fs.readFileSync(path.join(__dirname, "../apps-script/Code.gs"), "utf8");

function scriptPart(start, end) {
  return frontend.slice(frontend.indexOf(start), frontend.indexOf(end));
}

function draftClient() {
  const state = {
    sharedDrafts: { revision: 3, meetings: {}, locks: {}, fieldVersions: {} },
    sheetBaseValues: { "2099-01-01": { Theme: "Original" } },
    sheetPayload: { rolesCsv: "cached sheet", agendaCsv: "cached agenda" },
  };
  const context = vm.createContext({ state, Date });
  vm.runInContext(scriptPart("function applyConfirmedDraft(", "async function loadDashboard("), context);
  vm.runInContext("function renderSheetPayload(payload) { state.renderedPayload = payload; }", context);
  return { state, context };
}

test("confirmed snapshot renders from cached sheets with concurrent fields intact", () => {
  const { state, context } = draftClient();
  const drafts = { revision: 5, meetings: { "2099-01-01": { theme: { Theme: "Saved", "Theme Question": "Another person's edit" } } } };
  context.applyConfirmedDraft({ drafts }, "2099-01-01", "theme", { Theme: "Saved" });
  assert.equal(state.sharedDrafts, drafts);
  assert.equal(state.renderedPayload, state.sheetPayload);
});

test("older deployment applies confirmed values but preserves revision for polling", () => {
  const { state, context } = draftClient();
  const key = "2099-01-01|theme|Theme";
  context.applyConfirmedDraft({ fieldVersions: { [key]: 4 } }, "2099-01-01", "theme", { Theme: "Saved" });
  assert.equal(state.sharedDrafts.meetings["2099-01-01"].theme.Theme, "Saved");
  assert.equal(state.sharedDrafts.fieldVersions[key], 4);
  assert.equal(state.sharedDrafts.revision, 3);
  context.applyConfirmedDraft({ fieldVersions: { [key]: 5 } }, "2099-01-01", "theme", { Theme: "Original" });
  assert.equal(Object.hasOwn(state.sharedDrafts.meetings["2099-01-01"].theme, "Theme"), false);
});

test("save closes on confirmation without additional sheet or draft requests", async () => {
  const { state, context } = draftClient();
  const status = { className: "", textContent: "" };
  const dialog = { open: true };
  const button = { disabled: false };
  let confirm;
  let calls = 0;
  Object.assign(context, {
    WRITE_ENDPOINT: "configured", meetingSaveBusy: false, dashboardLoadVersion: 0,
    document: {
      getElementById: id => id === "meetingEditDialog" ? dialog : id === "saveMeetingEdit" ? button : status,
      querySelectorAll: () => [{ value: "Saved", dataset: { initialValue: "Original", editField: "Theme" } }],
    },
    canEditActiveMeeting: () => true,
    sheetDateValue: () => "2099-01-01",
    activeEditApiSection: () => "theme",
    setMeetingSaveBusy: busy => { context.meetingSaveBusy = busy; },
    apiRequest: () => { calls++; return new Promise(resolve => { confirm = resolve; }); },
    closeMeetingEditor: () => { dialog.open = false; },
    loadDashboard: () => { throw new Error("Save must not wait for another read"); },
    updateMeetingEditorState: () => {},
  });
  state.editMeeting = {};
  vm.runInContext(scriptPart("async function saveMeetingEditor(", "function openAdminApplyDialog("), context);
  const first = context.saveMeetingEditor({ preventDefault() {} });
  await context.saveMeetingEditor({ preventDefault() {} });
  assert.equal(calls, 1, "double submit is blocked");
  assert.equal(dialog.open, true, "do not report success before server confirmation");
  confirm({ updated: 1, fieldVersions: { "2099-01-01|theme|Theme": 1 } });
  await first;
  assert.equal(dialog.open, false);
  assert.equal(state.sharedDrafts.meetings["2099-01-01"].theme.Theme, "Saved");
  assert.equal(context.meetingSaveBusy, false);
});

function draftService() {
  const properties = new Map();
  let sheetReads = 0;
  const values = [["Date", "2099-01-01"], ["Theme", "Original"], ["Theme Question", "Question"]];
  const sheet = {
    getDataRange: () => ({ getValues: () => { sheetReads++; return values; } }),
    getRange: () => { throw new Error("Unexpected per-cell sheet request"); },
  };
  const context = vm.createContext({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key),
      setProperty: (key, value) => properties.set(key, value),
    }) },
    Utilities: {
      formatDate: (_, __, pattern) => ({ EEE: "Mon", H: "10", "yyyy-MM-dd": "2026-10-26" })[pattern],
      newBlob: value => ({ getBytes: () => Buffer.from(value) }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ put() {} }) },
    ContentService: { createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }), MimeType: { JSON: "json" } },
  });
  vm.runInContext(backend, context);
  const save = overrides => context.doPost({ postData: { contents: JSON.stringify({
    action: "saveDraft", meetingDate: "2099-01-01", section: "theme",
    updates: { Theme: "Saved", "Theme Question": "New question" },
    baseValues: { Theme: "Original", "Theme Question": "Question" },
    ...overrides,
  }) } });
  return { save, properties, get sheetReads() { return sheetReads; } };
}

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

test("sheet conflict permits immediate retry after loading current values and versions", () => {
  const service = draftService();
  assert.equal(service.save({ baseValues: { Theme: "Outdated" } }).code, "SHEET_CHANGED");
  const result = service.save({ fieldVersions: { Theme: 1 } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.drafts.locks, {});
});
