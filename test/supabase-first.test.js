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
