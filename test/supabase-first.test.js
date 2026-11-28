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
    checkSheetDifferences = () => new Promise(() => {});
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
  assert.equal(differences[1].current, "Replacement");
});
