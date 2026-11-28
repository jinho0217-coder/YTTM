const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = file => fs.readFileSync(path.join(__dirname, "..", "public", file), "utf8");
const app = read("app.js");
const endpoint = "https://example.supabase.co/snapshots";

function dashboard(syncedAt) {
  const calls = [];
  const context = vm.createContext({
    AbortSignal,
    window: { YTTM_CONFIG: { snapshotsEndpoint: endpoint, publishableKey: "test-key" } },
    console: { warn() {} },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === endpoint) return { ok: true, json: async () => [
        { sheet_name: "26_Roles", csv: "roles", synced_at: syncedAt },
        { sheet_name: "26_Agenda", csv: "agenda", synced_at: syncedAt },
      ] };
      return { ok: true, text: async () => "sheet" };
    },
  });
  vm.runInContext(app.slice(0, app.indexOf('document.getElementById("memberFilter").addEventListener')), context);
  return { context, calls };
}

test("the dashboard reads fresh role and agenda snapshots from Supabase", async () => {
  const syncedAt = new Date().toISOString();
  const { context, calls } = dashboard(syncedAt);
  const result = await context.fetchDashboardData();
  assert.equal(result.provider, "Supabase");
  assert.equal(result.rolesCsv, "roles");
  assert.equal(result.agendaCsv, "agenda");
  assert.equal(result.fetchedAt, syncedAt);
  assert.deepEqual(calls.map(call => call.url), [endpoint]);
  assert.equal(calls[0].options.headers.apikey, "test-key");
});

test("a stale snapshot falls back to Google Sheets without a write request", async () => {
  const { context, calls } = dashboard("2000-01-01T00:00:00Z");
  assert.equal((await context.fetchDashboardData()).provider, "Google Sheets");
  assert.equal(calls.length, 3);
  assert.ok(calls.slice(1).every(call => call.url.startsWith("https://docs.google.com/")));
  assert.ok(calls.every(call => !call.options.method));
});
