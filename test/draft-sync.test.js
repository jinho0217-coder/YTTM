const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const sync = fs.readFileSync(path.join(__dirname, "../public/draft-sync.js"), "utf8");
const key = "2099-01-01|theme|Theme";
const tick = () => new Promise(setImmediate);

function client(storage = new Map()) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { open: id === "meetingEditDialog", classList: { toggle() {} } });
    return elements.get(id);
  }
  const state = {
    editMeeting: {}, editFieldVersions: {}, sheetPayload: {},
    sheetBaseValues: { "2099-01-01": { Theme: "Original" } },
    sharedDrafts: { revision: 0, meetings: {}, fieldVersions: {} },
  };
  const requests = [];
  const context = vm.createContext({
    state, Date, Math, console, WRITE_ENDPOINT: "test-service", dashboardLoadVersion: 0,
    window: { YTTM_CONFIG: { writeEndpoint: "test-service" }, confirm: () => false },
    localStorage: {
      getItem: name => storage.get(name),
      setItem: (name, value) => storage.set(name, value),
      removeItem: name => storage.delete(name),
    },
    document: {
      getElementById: element,
      querySelectorAll: () => [{ value: context.input, dataset: { editField: "Theme", initialValue: context.initial || "Original" } }],
    },
    canEditActiveMeeting: () => true,
    isAssignmentField: () => false,
    activeEditApiSection: () => "theme",
    sheetDateValue: () => "2099-01-01",
    closeMeetingEditor: () => { element("meetingEditDialog").open = false; },
    apiRequest: payload => new Promise((resolve, reject) => requests.push({ payload, resolve, reject })),
    loadDashboard: async () => true,
  });
  vm.runInContext(sync, context);
  vm.runInContext(app.slice(app.indexOf("function applyConfirmedDraft("), app.indexOf("async function loadDashboard(")), context);
  vm.runInContext(app.slice(app.indexOf("async function saveMeetingEditor("), app.indexOf("function openAdminApplyDialog(")), context);
  vm.runInContext(`
    function renderDraftSyncState() { renderLocalSaveState(); }
    function renderSheetPayload() {
      state.displayed = state.sharedDrafts.meetings["2099-01-01"]?.theme?.Theme || "Original";
      localSaves.forEach(item => { if ("Theme" in item.payload.updates) state.displayed = item.payload.updates.Theme; });
      renderDraftSyncState();
    }
    globalThis.queue = localSaves;
  `, context);
  return {
    state, context, requests, storage, element,
    async save(value) {
      context.input = value;
      context.initial = state.displayed || "Original";
      state.editFieldVersions = context.localFieldVersions();
      element("meetingEditDialog").open = true;
      await context.saveMeetingEditor({ preventDefault() {} });
    },
  };
}

function confirmation(value, version) {
  return { ok: true, updated: 1, fieldVersions: { [key]: version }, drafts: {
    revision: version, fieldVersions: { [key]: version }, meetings: { "2099-01-01": { theme: { Theme: value } } },
  } };
}

test("save updates the screen and closes the editor while the server is still pending", async () => {
  const c = client();
  await c.save("Instant");
  assert.equal(c.element("meetingEditDialog").open, false);
  assert.equal(c.state.displayed, "Instant");
  assert.equal(c.requests.length, 1);
  assert.equal(c.state.sharedDrafts.revision, 0, "server snapshot remains unconfirmed");
  assert.equal(c.context.queue.length, 1);
  assert.equal(c.element("applySheetsButton").disabled, true);
  assert.match(c.element("localSaveMessage").textContent, /on this device.*background/);
  assert.ok([...c.storage.values()][0].includes("Instant"), "edit is durable before returning");
});

test("rapid re-edits stay visible and reach the server in order with successive versions", async () => {
  const c = client();
  await c.save("First");
  await c.save("Second");
  assert.equal(c.state.displayed, "Second");
  assert.equal(c.requests.length, 1, "only one server write at a time");
  assert.equal(c.context.queue[1].payload.fieldVersions.Theme, 1);
  c.requests[0].resolve(confirmation("First", 1));
  await tick();
  assert.equal(c.requests.length, 2);
  assert.equal(c.state.displayed, "Second", "old acknowledgement must not overwrite a newer local edit");
  c.requests[1].resolve(confirmation("Second", 2));
  await tick();
  assert.equal(c.context.queue.length, 0);
  assert.equal(c.state.sharedDrafts.fieldVersions[key], 2);
  assert.equal(c.element("localSavePanel").hidden, true);
});

test("refresh restores the queue and reuses the same request ID", async () => {
  const c = client();
  await c.save("Recover me");
  const restored = client(c.storage);
  assert.equal(restored.context.queue.length, 1);
  assert.equal(restored.context.queue[0].status, "queued");
  assert.equal(restored.context.queue[0].payload.requestId, c.requests[0].payload.requestId);
  restored.state.sharedDrafts.fieldVersions[key] = 1;
  assert.equal(restored.context.localFieldVersions()[key], 1, "already committed restored jobs are not counted twice");
  void restored.context.flushLocalSaves();
  assert.equal(restored.requests[0].payload.requestId, c.requests[0].payload.requestId);
  restored.requests[0].resolve(confirmation("Recover me", 1));
  await tick();
  assert.equal(restored.context.queue.length, 0);
});

test("network failure keeps the local edit, shows an error, and supports retry", async () => {
  const c = client();
  await c.save("Keep me");
  c.requests[0].reject(new Error("Offline"));
  await tick();
  assert.equal(c.state.displayed, "Keep me");
  assert.equal(c.context.queue[0].status, "error");
  assert.equal(c.element("localSaveActions").hidden, false);
  assert.match(c.element("localSaveMessage").textContent, /Offline/);
  await c.context.retryLocalSaves();
  assert.equal(c.requests[1].payload.requestId, c.requests[0].payload.requestId);
  c.requests[1].resolve(confirmation("Keep me", 1));
  await tick();
  assert.equal(c.context.queue.length, 0);
});

test("conflicts retain all local edits and cannot silently overwrite someone else's work", async () => {
  const c = client();
  await c.save("First");
  await c.save("Second");
  const error = new Error("Conflict");
  error.result = { code: "DRAFT_CHANGED" };
  c.requests[0].reject(error);
  await tick();
  assert.equal(c.context.queue.length, 2);
  assert.equal(c.state.displayed, "Second");
  assert.equal(c.context.queue[0].status, "conflict");
  await c.context.retryLocalSaves();
  assert.equal(c.requests.length, 1, "retry requires explicit conflict review");
});

test("unavailable local storage leaves the editor open and does not send or lose input", async () => {
  const c = client();
  c.context.localStorage.setItem = () => { throw new Error("Quota exceeded"); };
  await c.save("Do not lose this");
  assert.equal(c.element("meetingEditDialog").open, true);
  assert.equal(c.context.queue.length, 0);
  assert.equal(c.requests.length, 0);
  assert.match(c.element("meetingEditStatus").textContent, /Unable to save on this device/);
});

test("server rerender overlays locally cleared fields and pending edits in order", () => {
  const c = client();
  vm.runInContext(app.slice(app.indexOf("function applySharedDraftsToRows("), app.indexOf("function captureSheetBaseValues(")), c.context);
  c.context.clean = value => String(value ?? "").trim();
  c.context.rowMap = rows => new Map(rows.map(row => [row[0], { row }]));
  c.context.enqueueDraftSave({ action: "saveDraft", meetingDate: "2099-01-01", section: "theme", updates: { Theme: "" } });
  const rows = [["Date", "2099-01-01"], ["Theme", "Server value"]];
  c.context.applyLocalSavesToRows(rows);
  assert.equal(rows[1][1], "");
});

test("grouped guest changes are durable together or leave no partial local save", () => {
  const c = client();
  const payloads = [
    {action:'saveDraft',meetingDate:'2099-01-01',section:'attendees',updates:{Attendees:'[]'}},
    {action:'saveDraft',meetingDate:'2099-01-01',section:'roles',updates:{Timer:'Anne (G)'}}
  ];
  c.context.enqueueDraftSaves(payloads);
  assert.equal(c.context.queue.length, 2);
  assert.equal(JSON.parse([...c.storage.values()][0]).length, 2);
  c.context.localStorage.setItem = () => { throw new Error('Quota'); };
  assert.throws(() => c.context.enqueueDraftSaves(payloads), /Unable to keep/);
  assert.equal(c.context.queue.length, 2);
});
