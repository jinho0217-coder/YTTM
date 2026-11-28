const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const rolesCsv = ["Date,2026-11-29", ...Array.from({ length: 10 }, (_, i) => `Role ${i},Member ${i}`)].join("\n");
const snapshot = { rolesCsv, agendaCsv: "Session,Time\nOpening,10:00", provider: "Supabase" };

function dashboard(overrides = {}) {
  const element = { classList: { add() {}, remove() {} } };
  const context = vm.createContext({
    window: {},
    document: { getElementById: () => element },
    location: { hostname: "jinho0217-coder.github.io" },
    console: { warn() {}, error() {} },
    ...overrides,
  });
  vm.runInContext(app.slice(0, app.indexOf('document.getElementById("memberFilter").addEventListener')), context);
  return context;
}

test("Supabase renders while the shared drafts and Google Sheet comparison are still pending", async () => {
  const events = [];
  const context = dashboard({
    recordRender(payload) { events.push(payload.provider); },
  });
  vm.runInContext(`
    libraryRequest = async () => null;
    fetchSupabaseSnapshots = async () => snapshot;
    fetchSharedDrafts = () => new Promise(() => {});
    activeMeeting = () => null;
    renderLibraryBooking = () => {};
    renderSheetPayload = payload => { state.model = {}; recordRender(payload); };
    loadLiveSheet = () => new Promise(() => {});
  `, Object.assign(context, { snapshot }));
  assert.equal(await context.loadDashboard(), true);
  assert.deepEqual(events, ["Supabase"]);
});

test("Google Sheet comparison reports altered and cleared cells only", () => {
  const context = dashboard();
  const live = {
    rolesCsv: rolesCsv.replace("Role 0,Member 0", "Role 0,").replace("Role 1,Member 1", "Role 1, Replacement "),
    agendaCsv: snapshot.agendaCsv + "\n,",
  };
  const differences = context.dashboardSheetDifferences(snapshot, live);
  assert.equal(differences.length, 2);
  assert.equal(differences[0].stored, "Member 0");
  assert.equal(differences[0].current, "");
  assert.equal(differences[0].meetingDate, "2026-11-29");
  assert.equal(differences[0].field, "Role 0");
  assert.equal(differences[1].current, "Replacement");
});

test("2027 meetings follow 2026 and join role values by their row labels", () => {
  const context = dashboard();
  const rows = context.appendMeetingYear(
    [["Date", "2026-12-27"], ["#", "#622"], ["Chairperson", "December"], ["Timer", "Other"]],
    [["Date", "2027-01-03"], ["#", "#623"], ["Timer", "January timer"], ["Chairperson", "January"], ["Attendees", "Guest"]],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    ["Date", "2026-12-27", "2027-01-03"], ["#", "#622", "#623"],
    ["Chairperson", "December", "January"], ["Timer", "Other", "January timer"], ["Attendees", "", "Guest"],
  ]);
});

test("an approved batch routes identical column numbers to their own year's roles tab", () => {
  const backend = fs.readFileSync(path.join(__dirname, "../apps-script/Code.gs"), "utf8");
  const values = new Map();
  const writes = [
    { meetingDate: "2026-12-27", label: "Chairperson", previousValue: "", value: "December" },
    { meetingDate: "2027-01-03", label: "Chairperson", previousValue: "", value: "January" },
  ];
  const context = vm.createContext({
    SpreadsheetApp: {
      flush() {},
      openById: () => ({ getSheetByName: name => ({
        getDataRange: () => ({ getValues: () => [["Date", name === "27_Roles" ? "2027-01-03" : "2026-12-27"], ["Chairperson", ""]] }),
        getRange: (row, column) => ({ setValue: value => values.set(`${name}:${row}:${column}`, value) }),
      }) }),
    },
    Utilities: { formatDate: () => "2026-12-20" },
    rpc: (path, args) => {
      if (path === "rpc/yttm_claim_sheet_job") return { id: 1, attempt: 1, writes };
      assert.equal(path, "rpc/yttm_finish_sheet_job");
      assert.equal(args.p_error, undefined);
      return true;
    },
  });
  vm.runInContext(backend, context);
  vm.runInContext("primaryRequest = rpc", context);
  assert.equal(context.syncPrimarySheetJob(), true);
  assert.deepEqual([...values], [["26_Roles:2:2", "December"], ["27_Roles:2:2", "January"]]);
});

test("Supabase approval skips old empty sections and removes the approved field without dropping other drafts", () => {
  const backend = fs.readFileSync(path.join(__dirname, "../apps-script/Code.gs"), "utf8");
  const meetingDate = "2026-11-29";
  const drafts = {
    revision: 4,
    meetings: { "2026-12-06": { roles: {} }, [meetingDate]: { speeches: { "Time 3": "5-6-7" }, roles: { Timer: "Member" } } },
    bases: { [meetingDate]: { speeches: { "Time 3": "" }, roles: { Timer: "" } } },
  };
  const sheet = { getRange: () => ({ getValue: () => "" }) };
  let committed;
  const context = vm.createContext({
    drafts,
    contexts: [{ columns: [{ date: meetingDate, column: 2 }], rowByLabel: new Map([["Time 3", 5]]), sheet }],
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate: () => "2026-11-28" },
    commit(draft, request, writes) { committed = writes; return { ...draft, revision: 5 }; },
  });
  vm.runInContext(backend, context);
  vm.runInContext(`
    primaryConfigured = () => true;
    primaryRequest = () => [];
    requirePin = () => {};
    readDrafts = () => drafts;
    meetingSheetContexts = () => contexts;
    syncPrimarySheetJob = () => true;
    writeDrafts = commit;
    operationResponse = (request, result) => result;
  `, context);
  const request = { action: "applyDrafts", draftRevision: 4, selectionMode: "explicit", totalDrafts: 2,
    selections: [{ meetingDate, section: "speeches", label: "Time 3" }] };
  const result = context.doPost({ postData: { contents: JSON.stringify(request) } });
  assert.equal(result.ok, true);
  assert.equal(result.remaining, 1);
  assert.equal(committed[0].value, "5-6-7");
  assert.deepEqual(drafts.meetings, { [meetingDate]: { roles: { Timer: "Member" } } });
  assert.deepEqual(drafts.bases, { [meetingDate]: { roles: { Timer: "" } } });
});

test("live Sheet values replace the initial display and unapproved editable values enter the approval list", async () => {
  const roles = ["Date,2026-11-29", "Chairperson,", ...Array.from({ length: 9 }, (_, i) => `Role ${i},`)].join("\n");
  const live = { rolesCsv: roles.replace("Chairperson,", "Chairperson,William"), agendaCsv: "" };
  const context = dashboard({ live });
  vm.runInContext(`
    fetchPublicSheets = async () => live;
    renderSheetPayload = () => {};
  `, context);
  await context.loadLiveSheet({ rolesCsv: roles }, 0);
  const entries = context.pendingApprovalEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, "Chairperson");
  assert.equal(entries[0].value, "William");
  assert.equal(vm.runInContext("state.sheetPayload.provider", context), "Google Sheets");
});

test("reconciliation accepts either current source and rejects a stale comparison", () => {
  const backend = fs.readFileSync(path.join(__dirname, "../apps-script/Code.gs"), "utf8");
  const meetingDate = "2026-12-06";
  let committed;
  const context = vm.createContext({
    mockedContext: {
      columns: [{ date: meetingDate, column: 2 }],
      rowByLabel: new Map([["Chairperson", 4]]),
      sheet: { getRange: () => ({ getValue: () => "William", getFormula: () => "" }) },
    },
    mockWrite(drafts, request, writes) { committed = writes[0]; return { revision: 2 }; },
  });
  vm.runInContext(backend, context);
  vm.runInContext(`
    requirePin = () => {};
    primaryConfigured = () => true;
    sheetContext = () => mockedContext;
    readDrafts = () => ({ meetings: {} });
    primaryRequest = path => path.startsWith("yttm_meetings?") ? [{ fields: { Chairperson: "" } }] : [];
    syncPrimarySheetJob = () => {};
    writeDrafts = mockWrite;
    operationResponse = (request, result) => result;
  `, context);
  const choice = { meetingDate, field: "Chairperson", stored: "", current: "William" };
  assert.equal(context.reconcileSheetDifferences({ choices: [{ ...choice, source: "supabase" }] }).ok, true);
  assert.equal(committed.value, "");
  assert.equal(committed.previousValue, "William");
  assert.equal(context.reconcileSheetDifferences({ choices: [{ ...choice, source: "sheet" }] }).ok, true);
  assert.equal(committed.value, "William");
  assert.throws(() => context.reconcileSheetDifferences({ choices: [{ ...choice, current: "Other", source: "sheet" }] }), /changed after comparison/);
});
