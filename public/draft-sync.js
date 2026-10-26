// Keep unconfirmed edits separate from the server snapshot. Later local edits
// always win on screen until the queue is confirmed or explicitly discarded.
const LOCAL_SAVE_KEY = `yttm-pending-saves-v1:${window.YTTM_CONFIG?.writeEndpoint || ""}`;
let draftSyncBusy = false;
const localSaves = restoreLocalSaves();

function restoreLocalSaves() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_SAVE_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved.filter(item => item?.payload?.action === "saveDraft")
      .map(item => ({ ...item, status: item.status === "sending" ? "queued" : item.status }));
  } catch (error) {
    console.warn("Unable to restore pending edits.", error);
    return [];
  }
}

function persistLocalSaves() {
  localStorage.setItem(LOCAL_SAVE_KEY, JSON.stringify(localSaves));
}

function newSaveRequestId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function localFieldVersions() {
  const versions = { ...state.sharedDrafts.fieldVersions };
  localSaves.forEach(({ payload }) => {
    Object.keys(payload.updates).forEach(label => {
      const key = `${payload.meetingDate}|${payload.section}|${label}`;
      // A restored request may already be committed on the server. Its saved
      // expected version prevents counting that same write a second time.
      versions[key] = Math.max(Number(versions[key] || 0), Number(payload.fieldVersions?.[label] || 0) + 1);
    });
  });
  return versions;
}

function enqueueDraftSave(payload) {
  enqueueDraftSaves([payload]);
}
function enqueueDraftSaves(payloads) {
  const count = localSaves.length;
  localSaves.push(...payloads.map(payload => ({ status: "queued", payload: { ...payload, requestId: newSaveRequestId() } })));
  try {
    persistLocalSaves();
  } catch (error) {
    localSaves.splice(count);
    throw new Error("Unable to keep this edit on your device. Free browser storage and try again.");
  }
}

function applyLocalSavesToRows(rows) {
  localSaves.forEach(({ payload }) => {
    applySharedDraftsToRows(rows, { meetings: {
      [payload.meetingDate]: { [payload.section]: payload.updates },
    } });
  });
}

function renderLocalSaveState() {
  const panel = document.getElementById("localSavePanel");
  panel.hidden = !localSaves.length;
  if (!localSaves.length) return;
  const failed = localSaves.find(item => item.status === "error" || item.status === "conflict");
  const message = document.getElementById("localSaveMessage");
  message.textContent = failed
    ? `Your edits are kept on this device. ${failed.error}`
    : `Updated on this device · Syncing ${localSaves.length} save${localSaves.length === 1 ? "" : "s"} in the background…`;
  panel.classList.toggle("has-error", Boolean(failed));
  document.getElementById("localSaveActions").hidden = !failed;
  document.getElementById("retryLocalSaves").textContent = failed?.status === "conflict" ? "Review and send my changes" : "Retry sync";
  document.getElementById("localSaveValues").textContent = localSaves.map(({ payload }) =>
    `${payload.meetingDate}\n${Object.entries(payload.updates).map(([label, value]) => `${label}: ${value || "(clear value)"}`).join("\n")}`
  ).join("\n\n");
  const badge = document.getElementById("draftSyncBadge");
  badge.className = "draft-sync-badge pending";
  badge.textContent = failed ? "Saved on device · Sync needs attention" : `Syncing · ${localSaves.length}`;
  const applyButton = document.getElementById("applySheetsButton");
  applyButton.disabled = true;
  applyButton.textContent = "Waiting for sync";
}

async function flushLocalSaves() {
  if (draftSyncBusy || !state.sheetPayload || !localSaves.length || !WRITE_ENDPOINT) return;
  if (["error", "conflict"].includes(localSaves[0].status)) return;
  draftSyncBusy = true;
  try {
    while (localSaves.length) {
      const operation = localSaves[0];
      try {
        operation.status = "sending";
        persistLocalSaves();
        const result = await apiRequest(operation.payload);
        localSaves.shift();
        try { persistLocalSaves(); } catch (error) { localSaves.unshift(operation); throw error; }
        dashboardLoadVersion += 1;
        applyConfirmedDraft(result, operation.payload.meetingDate, operation.payload.section, operation.payload.updates);
      } catch (error) {
        const conflict = ["SHEET_CHANGED", "DRAFT_CHANGED"].includes(error.result?.code);
        operation.status = conflict ? "conflict" : "error";
        operation.error = conflict
          ? "Someone changed these fields first. Review before sending your local edits again."
          : `Sync is not confirmed: ${error.message}`;
        if (conflict) {
          const currentValues = error.result.sheetValues || Object.fromEntries(
            (error.result.conflicts || []).filter(item => typeof item === "object").map(item => [item.label, item.value ?? item.sheetValue ?? ""]));
          operation.error += ` Current shared values: ${Object.entries(currentValues).map(([label, value]) => `${label}: ${value || "(empty)"}`).join("; ")}`;
        }
        try { persistLocalSaves(); } catch (_) {}
        if (conflict) await loadDashboard(true);
        break;
      }
    }
  } finally {
    draftSyncBusy = false;
    renderDraftSyncState();
  }
}

async function retryLocalSaves() {
  if (draftSyncBusy || !localSaves.length) return;
  const conflict = localSaves[0].status === "conflict";
  if (conflict) {
    if (!window.confirm("Another person changed these fields. Send your local edits again using the latest version? This can replace their current values. Your pending edits are listed below.")) return;
    if (!await loadDashboard(true)) return;
    const versions = { ...state.sharedDrafts.fieldVersions };
    localSaves.forEach(({ payload }) => {
      Object.keys(payload.updates).forEach(label => {
        const key = `${payload.meetingDate}|${payload.section}|${label}`;
        payload.fieldVersions[label] = Number(versions[key] || 0);
        versions[key] = payload.fieldVersions[label] + 1;
        payload.baseValues[label] = state.sheetBaseValues[payload.meetingDate]?.[label] || "";
      });
      payload.requestId = newSaveRequestId();
    });
  }
  localSaves.forEach(item => { item.status = "queued"; delete item.error; });
  try { persistLocalSaves(); } catch (error) {
    localSaves[0].status = "error";
    localSaves[0].error = error.message;
    renderDraftSyncState();
    return;
  }
  renderDraftSyncState();
  void flushLocalSaves();
}

function discardLocalSaves() {
  if (draftSyncBusy || !localSaves.length) return;
  if (!window.confirm("Discard all edits that have not been confirmed by the shared service?")) return;
  try { localStorage.removeItem(LOCAL_SAVE_KEY); } catch (_) { return; }
  localSaves.length = 0;
  renderSheetPayload(state.sheetPayload);
  void loadDashboard(true);
}
