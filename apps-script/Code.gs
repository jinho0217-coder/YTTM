const SPREADSHEET_ID = "1arhgy3QSwHxyM9gBy6nXdw76N-94R53kf0ogV4Nq2lA";
const ROLES_SHEET = "26_Roles";
const AGENDA_SHEET = "26_Agenda";
const TIME_ZONE = "Asia/Seoul";
const DRAFTS_PROPERTY = "YTTM_SHARED_DRAFTS";
const DRAFTS_MANIFEST_PROPERTY = DRAFTS_PROPERTY + "_MANIFEST";
const AUDIT_PROPERTY = "YTTM_CHANGE_AUDIT";
const PIN_GUARD_PROPERTY = "YTTM_PIN_GUARD";
const ADMIN_PIN_PROPERTY = "YTTM_ADMIN_PIN";
const DEFAULT_ADMIN_PIN = "1004";
const MASTER_RESET_PIN = "1144";

const EDITABLE_FIELDS = {
  attendees: ["Attendees"],
  theme: ["Theme", "Theme Question", "Word of the day", "Quote of the day"],
  special: ["Special Event"],
  roles: [
    "Chairperson", "Toastmaster", "General Evaluator", "Table Topic Master", "Timer",
    "Ah Counter", "Grammarian", "Word & Quote Master", "Quiz Master", "Table Topic Evaluator",
    "Best Speaker", "Best evaluator", "Best table topic speaker",
  ],
  speeches: [
    "Speaker 1", "Project 1", "Title 1", "Time 1", "Evaluator 1",
    "Speaker 2", "Project 2", "Title 2", "Time 2", "Evaluator 2",
    "Speaker 3", "Project 3", "Title 3", "Time 3", "Evaluator 3",
    "Speaker 4", "Project 4", "Title 4", "Time 4", "Evaluator 4",
  ],
  awards: ["Best Speaker", "Best evaluator", "Best table topic speaker"],
};

function jsonResponse(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function webResponse(payload, callback) {
  if (callback && /^[A-Za-z_$][\w$\.]*$/.test(callback)) {
    return ContentService.createTextOutput(`${callback}(${JSON.stringify(payload)});`).setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return jsonResponse(payload);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sheetCsv(sheet) {
  return sheet.getDataRange().getDisplayValues()
    .map(row => row.map(csvCell).join(","))
    .join("\r\n");
}

function readSheetPayload() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const roles = spreadsheet.getSheetByName(ROLES_SHEET);
  const agenda = spreadsheet.getSheetByName(AGENDA_SHEET);
  if (!roles) throw new Error(`${ROLES_SHEET} was not found.`);
  if (!agenda) throw new Error(`${AGENDA_SHEET} was not found.`);
  return {
    ok: true,
    rolesCsv: sheetCsv(roles),
    agendaCsv: sheetCsv(agenda),
    fetchedAt: new Date().toISOString(),
    source: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit?gid=${roles.getSheetId()}`,
  };
}

function operationResponse(request, payload) {
  const requestId = String(request?.requestId || "");
  if (/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
    // A draft snapshot can exceed the cache value limit. Store only the receipt.
    const receipt = payload.ok && payload.draft
      ? { ok: true, draft: true, revision: payload.revision, updated: payload.updated }
      : payload;
    CacheService.getScriptCache().put(`YTTM_OPERATION_${requestId}`, JSON.stringify(receipt), 600);
  }
  return jsonResponse(payload);
}

function attachCurrentDrafts(result) {
  if (!result.ok || !result.draft) return result;
  const drafts = readDrafts();
  return { ...result, revision: drafts.revision, fieldVersions: drafts.fieldVersions, drafts };
}

function normalizedDate(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return Utilities.formatDate(value, TIME_ZONE, "yyyy-MM-dd");
  const text = String(value || "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return iso[0];
  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? "" : Utilities.formatDate(parsed, TIME_ZONE, "yyyy-MM-dd");
}

function meetingReferenceDate() {
  const now = new Date();
  const sundayAfterOne = Utilities.formatDate(now, TIME_ZONE, "EEE") === "Sun" && Number(Utilities.formatDate(now, TIME_ZONE, "H")) >= 13;
  const reference = sundayAfterOne ? new Date(now.getTime() + 24 * 60 * 60 * 1000) : now;
  return Utilities.formatDate(reference, TIME_ZONE, "yyyy-MM-dd");
}

function sheetContext() {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(ROLES_SHEET);
  if (!sheet) throw new Error("26_Roles was not found.");
  const values = sheet.getDataRange().getValues();
  if (!values.length) throw new Error("26_Roles is empty.");
  const rowByLabel = new Map();
  values.forEach((row, index) => rowByLabel.set(String(row[0] || "").trim(), index + 1));
  const referenceDate = meetingReferenceDate();
  const columns = [];
  for (let column = 2; column <= values[0].length; column += 1) {
    const date = normalizedDate(values[0][column - 1]);
    if (!date) continue;
    const special = String(values[(rowByLabel.get("Special Event") || 0) - 1]?.[column - 1] || "");
    const chair = String(values[(rowByLabel.get("Chairperson") || 0) - 1]?.[column - 1] || "");
    columns.push({ date, column, noMeeting: /no meeting/i.test(`${special} ${chair}`) });
  }
  const previousCandidates = columns.filter(item => item.date < referenceDate && !item.noMeeting);
  const previousMeeting = previousCandidates[previousCandidates.length - 1] || null;
  const allowedMeetings = columns.filter(item => item.date >= referenceDate || item.column === previousMeeting?.column).map(({ date, column }) => ({ date, column }));
  return { sheet, values, rowByLabel, allowedMeetings, columns };
}

function assignmentSection(label) {
  if (/^(Speaker|Evaluator) [1-4]$/.test(label)) return "speeches";
  return EDITABLE_FIELDS.roles.includes(label) && !EDITABLE_FIELDS.awards.includes(label) ? "roles" : "";
}

function confirmedValueOnDate(label, value, meetingDate, today) {
  return assignmentSection(label) && meetingDate <= today ? String(value).replace(/^◷\s+/, "") : value;
}

// Only the status changes automatically. Unapproved names remain in the draft.
function confirmDueAssignments(context, drafts, today) {
  const writes = [], audit = [];
  context.columns.filter(column => column.date <= today && !column.noMeeting).forEach(column => {
    context.rowByLabel.forEach((row, label) => {
      const section = assignmentSection(label);
      if (!section) return;
      const original = String(context.values[row - 1]?.[column.column - 1] ?? "").trim();
      const confirmed = confirmedValueOnDate(label, original, column.date, today);
      const updates = drafts.meetings[column.date]?.[section];
      const draftValue = updates?.[label];
      const nextDraft = draftValue === undefined ? undefined : confirmedValueOnDate(label, draftValue, column.date, today);
      if (original === confirmed && draftValue === nextDraft) return;
      if (original !== confirmed) {
        const range = context.sheet.getRange(row, column.column);
        if (range.getFormula?.()) return;
        writes.push({ row, column: column.column, original, value: confirmed });
        if (drafts.bases[column.date]?.[section]?.[label] === original) drafts.bases[column.date][section][label] = confirmed;
      }
      if (draftValue !== undefined) updates[label] = nextDraft;
      const key = fieldKey(column.date, section, label);
      drafts.fieldVersions[key] = Number(drafts.fieldVersions[key] || 0) + 1;
      audit.push({ at: new Date().toISOString(), action: "auto-confirm", meetingDate: column.date, section, label, value: nextDraft ?? confirmed });
    });
  });
  if (!audit.length) return drafts;
  let completed = 0;
  try {
    writes.forEach(item => {
      context.sheet.getRange(item.row, item.column).setValue(item.value.startsWith("=") ? "'" + item.value : item.value);
      completed += 1;
    });
    if (writes.length) SpreadsheetApp.flush();
    writeDrafts(drafts);
  } catch (error) {
    for (let index = completed - 1; index >= 0; index -= 1) {
      try { context.sheet.getRange(writes[index].row, writes[index].column).setValue(writes[index].original); } catch (_) {}
    }
    if (completed) SpreadsheetApp.flush();
    throw error;
  }
  writes.forEach(item => { context.values[item.row - 1][item.column - 1] = item.value; });
  appendAudit(audit);
  return drafts;
}

function refreshAutomaticConfirmations() {
  const today = Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd");
  const cache = CacheService.getScriptCache();
  if (cache.get("YTTM_AUTO_CONFIRM_DAY") === today) return;
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    if (cache.get("YTTM_AUTO_CONFIRM_DAY") === today) return;
    confirmDueAssignments(sheetContext(), readDrafts(), today);
    cache.put("YTTM_AUTO_CONFIRM_DAY", today, 300);
  } finally { lock.releaseLock(); }
}

function emptyDrafts() {
  return { revision: 0, updatedAt: "", meetings: {}, locks: {}, bases: {}, fieldVersions: {} };
}

function primaryConfigured() {
  return Boolean(PropertiesService.getScriptProperties().getProperty("YTTM_SUPABASE_KEY"));
}

function primaryRequest(path, body) {
  const key = PropertiesService.getScriptProperties().getProperty("YTTM_SUPABASE_KEY");
  if (!key || !key.startsWith("sb_secret_")) throw new Error("Set YTTM_SUPABASE_KEY to a Supabase secret key.");
  const options = { headers: { apikey: key }, muteHttpExceptions: true };
  if (body !== undefined) {
    options.method = "post";
    options.contentType = "application/json";
    options.payload = JSON.stringify(body);
  }
  const response = UrlFetchApp.fetch("https://zyiosfhyjwkmfprhmdem.supabase.co/rest/v1/" + path, options);
  if (response.getResponseCode() >= 300) throw new Error("Supabase request failed (" + response.getResponseCode() + ").");
  return JSON.parse(response.getContentText());
}

// Install this trigger from the editor using the account that owns the web app.
function installPrimarySheetSync() {
  if (!primaryConfigured()) throw new Error("Set the Supabase key in Script Properties first.");
  if (!ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === "retryPrimarySheetSync")) {
    ScriptApp.newTrigger("retryPrimarySheetSync").timeBased().everyMinutes(1).create();
  }
}

function retryPrimarySheetSync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try { syncPrimarySheetJob(); }
  finally { lock.releaseLock(); }
}

function syncPrimarySheetJob() {
  const job = primaryRequest("rpc/yttm_claim_sheet_job", {});
  if (!job) return false;
  try {
    const context = sheetContext();
    const targets = job.writes.map(item => {
      const column = context.columns.find(entry => entry.date === item.meetingDate)?.column;
      const row = context.rowByLabel.get(item.label);
      if (!column || (!row && item.label !== "Attendees")) throw new Error("Sheet layout changed.");
      const current = row ? String(context.values[row - 1]?.[column - 1] ?? "").trim() : "";
      if (!job.force && current !== item.previousValue && current !== item.value) {
        throw new Error("Google Sheets changed after approval. Restore or reconcile the affected cell before retry.");
      }
      return { ...item, row, column, current };
    });
    targets.forEach(item => {
      if (item.current === item.value) return;
      let row = item.row || context.rowByLabel.get(item.label);
      if (!row) {
        row = context.sheet.getLastRow() + 1;
        if (row > context.sheet.getMaxRows()) context.sheet.insertRowsAfter(context.sheet.getMaxRows(), 1);
        context.sheet.getRange(row, 1).setValue(item.label);
        context.rowByLabel.set(item.label, row);
      }
      context.sheet.getRange(row, item.column).setValue(item.value.startsWith("=") ? "'" + item.value : item.value);
    });
    SpreadsheetApp.flush();
    return primaryRequest("rpc/yttm_finish_sheet_job", { p_id: job.id, p_attempt: job.attempt });
  } catch (error) {
    primaryRequest("rpc/yttm_finish_sheet_job", { p_id: job.id, p_attempt: job.attempt, p_error: error.message });
    return false;
  }
}

function readDrafts() {
  if (primaryConfigured()) {
    const [stored] = primaryRequest("yttm_primary_state?id=eq.true&select=payload");
    if (stored) return stored.payload;
  }
  const properties = PropertiesService.getScriptProperties().getProperties();
  let raw = properties[DRAFTS_PROPERTY];
  if (properties[DRAFTS_MANIFEST_PROPERTY]) {
    const { slot, count } = JSON.parse(properties[DRAFTS_MANIFEST_PROPERTY]);
    if (![0, 1].includes(slot) || !Number.isInteger(count) || count < 1 || count > 100) {
      throw new Error("The shared draft storage manifest is invalid.");
    }
    const chunks = Array.from({ length: count }, (_, index) => properties[draftChunkKey(slot, index)]);
    if (chunks.some(chunk => typeof chunk !== "string" || !chunk.length)) {
      throw new Error("The shared draft storage is incomplete.");
    }
    raw = chunks.join("");
  }
  if (!raw) return emptyDrafts();
  const parsed = JSON.parse(raw);
  if (!parsed?.meetings) throw new Error("The shared draft storage is invalid.");
  // Retire cooldowns saved by previous deployments.
  parsed.locks = {};
  parsed.bases = parsed.bases || {};
  parsed.fieldVersions = parsed.fieldVersions || {};
  return parsed;
}

function draftChunkKey(slot, index) {
  return `${DRAFTS_PROPERTY}_${slot}_${index}`;
}

function writeDrafts(drafts, request, writes) {
  const revision = Number(drafts.revision || 0);
  drafts.revision = Number(drafts.revision || 0) + 1;
  drafts.updatedAt = new Date().toISOString();
  if (primaryConfigured()) {
    const [stored] = primaryRequest("yttm_primary_state?id=eq.true&select=revision,payload");
    if (stored && Number(stored.payload.revision) !== revision) throw new Error("The shared draft changed. Refresh and retry.");
    const receipt = primaryRequest("rpc/yttm_commit_primary", {
      p_expected: stored ? stored.revision : -1,
      p_payload: drafts,
      p_request_id: request?.requestId || Utilities.getUuid(),
      p_fingerprint: JSON.stringify([request?.action, request?.meetingDate, request?.section, request?.updates, writes]),
      p_result: { ok: true, applied: Boolean(writes), revision: drafts.revision, updated: writes?.length || Object.keys(request?.updates || {}).length },
      p_writes: writes || null,
      p_force: request?.force === true,
    });
    if (receipt.retry) throw new Error("The shared draft changed. Refresh and retry.");
    return drafts;
  }
  const serialized = JSON.stringify(drafts);
  if (Utilities.newBlob(serialized).getBytes().length > 180000) {
    throw new Error("The shared draft is full. Ask an administrator to apply the pending changes before adding more.");
  }
  const properties = PropertiesService.getScriptProperties();
  const stored = properties.getProperties();
  const manifest = JSON.parse(stored[DRAFTS_MANIFEST_PROPERTY] || "null");
  const slot = manifest?.slot === 0 ? 1 : 0;
  const chunks = {};
  let count = 0;
  for (let start = 0; start < serialized.length;) {
    let end = Math.min(start + 2000, serialized.length);
    // Keep each value under the byte limit and keep surrogate pairs together.
    if (end < serialized.length && /[\uD800-\uDBFF]/.test(serialized[end - 1])) end -= 1;
    chunks[draftChunkKey(slot, count++)] = serialized.slice(start, end);
    start = end;
  }
  // Publish only after every chunk is written. An interrupted write leaves
  // the previous snapshot readable, including the legacy single-property one.
  properties.setProperties(chunks);
  properties.setProperty(DRAFTS_MANIFEST_PROPERTY, JSON.stringify({ slot, count }));
  // Retire the previous snapshot after publication, especially after approval
  // clears the draft. Leave unrelated script properties intact.
  const obsolete = Object.fromEntries(Object.keys(stored)
    .filter(key => stored[key] && (key === DRAFTS_PROPERTY ||
      (/^YTTM_SHARED_DRAFTS_[01]_\d+$/.test(key) && !Object.hasOwn(chunks, key))))
    .map(key => [key, ""]));
  try {
    if (Object.keys(obsolete).length) properties.setProperties(obsolete);
  } catch (error) {
    console.error("Unable to clear previous draft chunks.", error);
  }
  return drafts;
}

function fieldKey(meetingDate, section, label) {
  return `${meetingDate}|${section}|${label}`;
}

function appendAudit(entries) {
  if (!entries.length) return;
  const properties = PropertiesService.getScriptProperties();
  let history = [];
  try { history = JSON.parse(properties.getProperty(AUDIT_PROPERTY) || "[]"); } catch (_) {}
  history.push(...entries);
  while (history.length > 40 || Utilities.newBlob(JSON.stringify(history)).getBytes().length > 8000) history.shift();
  properties.setProperty(AUDIT_PROPERTY, JSON.stringify(history));
}

function validatedUpdates(section, updates) {
  if (!Object.prototype.hasOwnProperty.call(EDITABLE_FIELDS, section)) throw new Error("Unsupported edit section.");
  const allowedFields = new Set(EDITABLE_FIELDS[section]);
  const entries = Object.entries(updates && typeof updates === "object" ? updates : {});
  if (!entries.length) throw new Error("No changes were supplied.");
  const cleanUpdates = {};
  entries.forEach(([label, rawValue]) => {
    if (!allowedFields.has(label)) throw new Error(`Field is not allowed: ${label}`);
    const value = String(rawValue ?? "").trim();
    if (value.length > (section === "attendees" ? 6000 : 500)) throw new Error(`Value is too long: ${label}`);
    if (section === "attendees" && value) {
      const people = JSON.parse(value);
      if (!Array.isArray(people) || people.length > 80 || people.some(person =>
        !person || typeof person.name !== "string" || !person.name.trim() || person.name.length > 80 || typeof person.guest !== "boolean" || Object.keys(person).some(key => !["name", "guest"].includes(key)))) {
        throw new Error("Invalid attendee list.");
      }
      const names = people.map(person => person.name.trim().toLocaleLowerCase());
      if (new Set(names).size !== names.length) throw new Error("Duplicate attendee names.");
    }
    cleanUpdates[label] = value;
  });
  return cleanUpdates;
}

function requireAllowedMeeting(context, meetingDate) {
  const target = context.allowedMeetings.find(meeting => meeting.date === String(meetingDate || ""));
  if (!target) throw new Error("Only the immediately previous meeting and future meetings can be edited.");
  return target;
}

function adminPin() {
  return PropertiesService.getScriptProperties().getProperty(ADMIN_PIN_PROPERTY) || DEFAULT_ADMIN_PIN;
}

function requireCredential(pin, allowMasterReset) {
  const properties = PropertiesService.getScriptProperties();
  let guard = { failures: 0, blockedUntil: 0 };
  try { guard = { ...guard, ...JSON.parse(properties.getProperty(PIN_GUARD_PROPERTY) || "{}") }; } catch (_) {}
  const now = Date.now();
  if (Number(guard.blockedUntil || 0) > now) {
    const seconds = Math.ceil((guard.blockedUntil - now) / 1000);
    throw new Error(`Too many incorrect PIN attempts. Try again in ${seconds} seconds.`);
  }
  const suppliedPin = String(pin || "");
  const validAdminPin = /^\d{4}$/.test(suppliedPin) && suppliedPin === adminPin();
  const validMasterPin = allowMasterReset === true && suppliedPin === MASTER_RESET_PIN;
  if (!validAdminPin && !validMasterPin) {
    guard.failures = Number(guard.failures || 0) + 1;
    guard.blockedUntil = guard.failures >= 5 ? now + 5 * 60 * 1000 : 0;
    if (guard.blockedUntil) guard.failures = 0;
    properties.setProperty(PIN_GUARD_PROPERTY, JSON.stringify(guard));
    throw new Error("Incorrect administrator PIN.");
  }
  properties.deleteProperty(PIN_GUARD_PROPERTY);
}

function requirePin(pin) {
  requireCredential(pin, false);
}

function doGet(event) {
  const action = String(event?.parameter?.action || "getDrafts");
  const callback = String(event?.parameter?.callback || "");
  if (action === "storageHealth") {
    try {
      const state = primaryRequest("yttm_primary_state?select=revision&limit=1");
      return webResponse({ ok: Array.isArray(state), storage: "Supabase" }, callback);
    } catch (error) {
      return webResponse({ ok: false, storage: "Supabase" }, callback);
    }
  }
  if (action === "getSheets") {
    try {
      refreshAutomaticConfirmations();
      return webResponse(readSheetPayload(), callback);
    } catch (error) {
      return webResponse({ ok: false, error: error.message || String(error) }, callback);
    }
  }
  if (action === "status") {
    const requestId = String(event?.parameter?.requestId || "");
    const raw = /^[A-Za-z0-9_-]{8,80}$/.test(requestId) ? CacheService.getScriptCache().get(`YTTM_OPERATION_${requestId}`) : "";
    const result = raw ? JSON.parse(raw) : { ok: false, pending: true };
    try {
      return webResponse(attachCurrentDrafts(result), callback);
    } catch (error) {
      return webResponse({ ok: false, error: error.message || String(error) }, callback);
    }
  }
  try {
    try {
      refreshAutomaticConfirmations();
    } catch (error) {
      console.error("Unable to refresh automatic confirmations.", error);
    }
    return webResponse({ ok: true, drafts: readDrafts() }, callback);
  } catch (error) {
    return webResponse({ ok: false, error: error.message || String(error) }, callback);
  }
}

function doPost(event) {
  const lock = LockService.getScriptLock();
  let request = {};
  try {
    lock.waitLock(10000);
    request = JSON.parse(event?.postData?.contents || "{}");
    if (primaryConfigured() && ["saveDraft", "applyDrafts"].includes(request.action) &&
        /^[A-Za-z0-9_-]{8,80}$/.test(String(request.requestId || ""))) {
      const [receipt] = primaryRequest("yttm_save_receipts?request_id=eq." + request.requestId + "&select=result");
      if (receipt) {
        if (request.action === "applyDrafts") requirePin(request.pin);
        return operationResponse(request, { ...receipt.result, draft: request.action === "saveDraft", drafts: readDrafts() });
      }
    }
    // Reloads and retries reuse the same ID: acknowledge an already committed
    // draft without writing it twice or creating a false version conflict.
    if (request.action === "saveDraft" && /^[A-Za-z0-9_-]{8,80}$/.test(String(request.requestId || ""))) {
      const previous = CacheService.getScriptCache().get(`YTTM_OPERATION_${request.requestId}`);
      if (previous) {
        const result = JSON.parse(previous);
        if (result.ok) return jsonResponse(attachCurrentDrafts(result));
      }
    }
    const context = sheetContext();
    const today = Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd");
    confirmDueAssignments(context, readDrafts(), today);

    if (request.action === "saveDraft") {
      const target = requireAllowedMeeting(context, request.meetingDate);
      const updates = validatedUpdates(request.section, request.updates);
      Object.keys(updates).forEach(label => { updates[label] = confirmedValueOnDate(label, updates[label], target.date, today); });
      const drafts = readDrafts();
      const expectedVersions = request.fieldVersions && typeof request.fieldVersions === "object" ? request.fieldVersions : {};
      const draftConflicts = [];
      Object.keys(updates).forEach(label => {
        const key = fieldKey(target.date, request.section, label);
        const currentVersion = Number(drafts.fieldVersions[key] || 0);
        const expectedVersion = Number(expectedVersions[label] || 0);
        if (currentVersion !== expectedVersion) {
          draftConflicts.push({ label, version: currentVersion, value: String(drafts.meetings?.[target.date]?.[request.section]?.[label] ?? "") });
        }
      });
      if (draftConflicts.length) {
        return operationResponse(request, { ok: false, code: "DRAFT_CHANGED", error: "Another person changed this item while you were editing. The latest shared value has been loaded.", conflicts: draftConflicts, revision: drafts.revision });
      }
      const expectedValues = request.baseValues && typeof request.baseValues === "object" ? request.baseValues : {};
      const sheetValues = {};
      const sheetConflicts = [];
      Object.keys(updates).forEach(label => {
        const row = context.rowByLabel.get(label);
        if (!row && label !== "Attendees") throw new Error(`Row was not found: ${label}`);
        const sheetValue = String(context.values[row - 1]?.[target.column - 1] ?? "").trim();
        sheetValues[label] = sheetValue;
        if (Object.prototype.hasOwnProperty.call(expectedValues, label) && String(expectedValues[label] ?? "").trim() !== sheetValue) {
          sheetConflicts.push(label);
        }
      });
      if (sheetConflicts.length) {
        return operationResponse(request, { ok: false, code: "SHEET_CHANGED", error: "Google Sheets changed first. Reload the latest sheet data, review it and edit again.", conflicts: sheetConflicts, sheetValues });
      }
      if (!drafts.meetings[target.date]) drafts.meetings[target.date] = {};
      if (!drafts.bases[target.date]) drafts.bases[target.date] = {};
      if (!drafts.bases[target.date][request.section]) drafts.bases[target.date][request.section] = {};
      const sectionDraft = { ...(drafts.meetings[target.date][request.section] || {}) };
      Object.entries(updates).forEach(([label, value]) => {
        const row = context.rowByLabel.get(label);
        if (!row && label !== "Attendees") throw new Error(`Row was not found: ${label}`);
        const sheetValue = sheetValues[label];
        if (value === sheetValue) delete sectionDraft[label];
        else {
          sectionDraft[label] = value;
          if (!Object.prototype.hasOwnProperty.call(drafts.bases[target.date][request.section], label)) drafts.bases[target.date][request.section][label] = sheetValue;
        }
        if (value === sheetValue) delete drafts.bases[target.date][request.section][label];
        const key = fieldKey(target.date, request.section, label);
        drafts.fieldVersions[key] = Number(drafts.fieldVersions[key] || 0) + 1;
      });
      if (Object.keys(sectionDraft).length) drafts.meetings[target.date][request.section] = sectionDraft;
      else delete drafts.meetings[target.date][request.section];
      if (!Object.keys(drafts.meetings[target.date]).length) delete drafts.meetings[target.date];
      const saved = writeDrafts(drafts, request);
      try {
        appendAudit(Object.entries(updates).map(([label, value]) => ({ at: new Date().toISOString(), action: "draft", meetingDate: target.date, section: request.section, label, value, revision: saved.fieldVersions[fieldKey(target.date, request.section, label)] })));
      } catch (error) {
        console.error("Unable to record the committed draft in the audit log.", error);
      }
      return operationResponse(request, { ok: true, draft: true, revision: saved.revision, fieldVersions: saved.fieldVersions, drafts: saved, updated: Object.keys(updates).length });
    }

    if (request.action === "applyDrafts") {
      requirePin(request.pin);
      const drafts = readDrafts();
      const expectedRevision = Number(request.draftRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision !== Number(drafts.revision || 0)) {
        return operationResponse(request, { ok: false, code: "DRAFT_CHANGED", error: "The pending changes changed before approval. Reload the page and review them again.", revision: drafts.revision });
      }
      const conflicts = [];
      const writes = [];
      const allEntries = [];
      if (request.selectionMode !== "explicit" || !Array.isArray(request.selections)) {
        throw new Error("A complete explicit selection is required. No changes were applied.");
      }
      const requestedSelections = request.selections;
      const selectedKeys = new Set(requestedSelections.map(item =>
        fieldKey(String(item?.meetingDate || ""), String(item?.section || ""), String(item?.label || ""))));
      if (selectedKeys.size !== requestedSelections.length || [...selectedKeys].some(key => /^\||\|\||\|$/.test(key))) {
        throw new Error("The selected change list is invalid. No changes were applied.");
      }
      Object.entries(drafts.meetings || {}).forEach(([meetingDate, sections]) => {
        Object.entries(sections || {}).forEach(([section, rawUpdates]) => {
          const updates = validatedUpdates(section, rawUpdates);
          Object.keys(updates).forEach(label => {
            const key = fieldKey(meetingDate, section, label);
            allEntries.push({ meetingDate, section, label, value: updates[label] });
            if (!selectedKeys.has(key)) return;
            const target = context.columns.find(column => column.date === meetingDate);
            if (!target) throw new Error("The selected meeting date was not found in Google Sheets.");
            const row = context.rowByLabel.get(label);
            if (!row && label !== "Attendees") throw new Error(`Row was not found: ${label}`);
            const currentValue = row ? String(context.sheet.getRange(row, target.column).getValue() ?? "").trim() : "";
            const baseValue = String(drafts.bases?.[meetingDate]?.[section]?.[label] ?? currentValue).trim();
            if (currentValue !== baseValue) conflicts.push({ meetingDate, section, label, sheetValue: currentValue, draftValue: updates[label] });
            writes.push({ meetingDate, section, label, row, column: target.column, previousValue: currentValue, value: updates[label] });
          });
        });
      });
      if (Number(request.totalDrafts) !== allEntries.length || [...selectedKeys].some(key => !allEntries.some(item => fieldKey(item.meetingDate, item.section, item.label) === key))) {
        return operationResponse(request, { ok: false, code: "DRAFT_CHANGED", error: "The pending change list no longer matches this approval. Reload the page and review it again.", revision: drafts.revision });
      }
      if (conflicts.length && request.force !== true) {
        return operationResponse(request, { ok: false, code: "SHEET_CHANGED", error: "Google Sheets changed after the shared draft was created.", conflicts });
      }
      if (!writes.length) throw new Error("Select at least one pending change to apply.");
      if (primaryConfigured()) {
        writes.forEach(({ meetingDate, section, label }) => {
          delete drafts.meetings[meetingDate][section][label];
          if (drafts.bases?.[meetingDate]?.[section]) delete drafts.bases[meetingDate][section][label];
        });
        const saved = writeDrafts(drafts, request, writes);
        let syncPending = true;
        try {
          syncPrimarySheetJob();
          syncPending = primaryRequest("yttm_sheet_outbox?state=neq.done&select=id&limit=1").length > 0;
        }
        catch (error) { console.error("Sheet sync queued for retry.", error); }
        return operationResponse(request, { ok: true, applied: true, syncPending, revision: saved.revision, updated: writes.length, remaining: allEntries.length - writes.length });
      }
      let completed = 0;
      try {
        writes.forEach(item => {
          if (!item.row && item.label === "Attendees") {
            let row = context.rowByLabel.get("Attendees");
            if (!row) {
              row = context.sheet.getLastRow() + 1;
              if (row > context.sheet.getMaxRows()) context.sheet.insertRowsAfter(context.sheet.getMaxRows(), 1);
              context.sheet.getRange(row, 1).setValue("Attendees");
              context.rowByLabel.set("Attendees", row);
            }
            item.row = row;
          }
          context.sheet.getRange(item.row, item.column).setValue(item.value);
          completed += 1;
        });
        SpreadsheetApp.flush();
      } catch (writeError) {
        for (let index = completed - 1; index >= 0; index -= 1) {
          try { context.sheet.getRange(writes[index].row, writes[index].column).setValue(writes[index].previousValue); } catch (_) {}
        }
        SpreadsheetApp.flush();
        throw new Error(`Google Sheets was only partially updated, so the operation was rolled back. ${writeError.message || writeError}`);
      }
      writes.forEach(({ meetingDate, section, label }) => {
        for (const entries of [drafts.meetings, drafts.bases]) {
          const meeting = entries[meetingDate];
          if (!meeting?.[section]) continue;
          delete meeting[section][label];
          if (!Object.keys(meeting[section]).length) delete meeting[section];
          if (!Object.keys(meeting).length) delete entries[meetingDate];
        }
      });
      const saved = writeDrafts(drafts);
      try {
        appendAudit(writes.map(item => ({ at: new Date().toISOString(), action: request.force === true ? "force-apply" : "apply", meetingDate: item.meetingDate, section: item.section, label: item.label, from: item.previousValue, value: item.value })));
      } catch (error) {
        console.error("Unable to record the applied drafts in the audit log.", error);
      }
      return operationResponse(request, { ok: true, applied: true, revision: saved.revision, updated: writes.length, remaining: allEntries.length - writes.length });
    }

    if (request.action === "changePin") {
      requireCredential(request.currentPin, true);
      if (!/^\d{4}$/.test(String(request.newPin || ""))) throw new Error("The new PIN must contain exactly 4 digits.");
      if (String(request.newPin) === MASTER_RESET_PIN) throw new Error("The administrator PIN cannot be the same as the master reset PIN.");
      PropertiesService.getScriptProperties().setProperty(ADMIN_PIN_PROPERTY, String(request.newPin));
      return operationResponse(request, { ok: true, pinChanged: true, resetWithMaster: String(request.currentPin) === MASTER_RESET_PIN });
    }

    throw new Error("Unsupported action.");
  } catch (error) {
    return operationResponse(request, { ok: false, error: error.message || String(error) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}
