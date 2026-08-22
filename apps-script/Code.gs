const SPREADSHEET_ID = "1arhgy3QSwHxyM9gBy6nXdw76N-94R53kf0ogV4Nq2lA";
const ROLES_SHEET = "26_Roles";
const TIME_ZONE = "Asia/Seoul";
const DRAFTS_PROPERTY = "YTTM_SHARED_DRAFTS";
const AUDIT_PROPERTY = "YTTM_CHANGE_AUDIT";
const PIN_GUARD_PROPERTY = "YTTM_PIN_GUARD";
const ADMIN_PIN_PROPERTY = "YTTM_ADMIN_PIN";
const DEFAULT_ADMIN_PIN = "1004";
const MASTER_RESET_PIN = "1144";

const EDITABLE_FIELDS = {
  theme: ["Theme", "Theme Question", "Word of the day", "Quote of the day"],
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

function operationResponse(request, payload) {
  const requestId = String(request?.requestId || "");
  if (/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
    CacheService.getScriptCache().put(`YTTM_OPERATION_${requestId}`, JSON.stringify(payload), 120);
  }
  return jsonResponse(payload);
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
  const specialRow = rowByLabel.get("Special Event");
  const chairRow = rowByLabel.get("Chairperson");
  const upcoming = [];
  for (let column = 2; column <= values[0].length; column += 1) {
    const date = normalizedDate(values[0][column - 1]);
    if (!date || date < meetingReferenceDate()) continue;
    const special = specialRow ? String(values[specialRow - 1][column - 1] || "") : "";
    const chair = chairRow ? String(values[chairRow - 1][column - 1] || "") : "";
    if (/no meeting/i.test(`${special} ${chair}`)) continue;
    upcoming.push({ date, column });
  }
  return { sheet, rowByLabel, allowedMeetings: upcoming.slice(0, 2) };
}

function emptyDrafts() {
  return { revision: 0, updatedAt: "", meetings: {}, locks: {}, bases: {}, fieldVersions: {} };
}

function readDrafts() {
  const raw = PropertiesService.getScriptProperties().getProperty(DRAFTS_PROPERTY);
  if (!raw) return emptyDrafts();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.meetings) return emptyDrafts();
    parsed.locks = parsed.locks || {};
    parsed.bases = parsed.bases || {};
    parsed.fieldVersions = parsed.fieldVersions || {};
    return parsed;
  } catch (_) {
    return emptyDrafts();
  }
}

function writeDrafts(drafts) {
  drafts.revision = Number(drafts.revision || 0) + 1;
  drafts.updatedAt = new Date().toISOString();
  const serialized = JSON.stringify(drafts);
  if (Utilities.newBlob(serialized).getBytes().length > 8800) {
    throw new Error("The shared draft is full. Ask an administrator to apply the pending changes before adding more.");
  }
  PropertiesService.getScriptProperties().setProperty(DRAFTS_PROPERTY, serialized);
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
    if (value.length > 500) throw new Error(`Value is too long: ${label}`);
    cleanUpdates[label] = value;
  });
  return cleanUpdates;
}

function requireAllowedMeeting(context, meetingDate) {
  const target = context.allowedMeetings.find(meeting => meeting.date === String(meetingDate || ""));
  if (!target) throw new Error("Only Coming Up and Next Meeting can be edited.");
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
  if (action === "status") {
    const requestId = String(event?.parameter?.requestId || "");
    const raw = /^[A-Za-z0-9_-]{8,80}$/.test(requestId) ? CacheService.getScriptCache().get(`YTTM_OPERATION_${requestId}`) : "";
    return webResponse(raw ? JSON.parse(raw) : { ok: false, pending: true }, callback);
  }
  const drafts = readDrafts();
  return webResponse({ ok: true, drafts }, callback);
}

function doPost(event) {
  const lock = LockService.getScriptLock();
  let request = {};
  try {
    lock.waitLock(10000);
    request = JSON.parse(event?.postData?.contents || "{}");
    const context = sheetContext();

    if (request.action === "saveDraft") {
      const target = requireAllowedMeeting(context, request.meetingDate);
      const updates = validatedUpdates(request.section, request.updates);
      const drafts = readDrafts();
      const now = Date.now();
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
        if (!row) throw new Error(`Row was not found: ${label}`);
        const sheetValue = String(context.sheet.getRange(row, target.column).getValue() ?? "").trim();
        sheetValues[label] = sheetValue;
        if (Object.prototype.hasOwnProperty.call(expectedValues, label) && String(expectedValues[label] ?? "").trim() !== sheetValue) {
          sheetConflicts.push(label);
        }
      });
      if (sheetConflicts.length) {
        if (!drafts.locks[target.date]) drafts.locks[target.date] = {};
        if (!drafts.locks[target.date][request.section]) drafts.locks[target.date][request.section] = {};
        sheetConflicts.forEach(label => {
          drafts.locks[target.date][request.section][label] = now + 60000;
          if (drafts.meetings?.[target.date]?.[request.section]) delete drafts.meetings[target.date][request.section][label];
          if (drafts.bases?.[target.date]?.[request.section]) delete drafts.bases[target.date][request.section][label];
        });
        if (drafts.meetings?.[target.date]?.[request.section] && !Object.keys(drafts.meetings[target.date][request.section]).length) delete drafts.meetings[target.date][request.section];
        if (drafts.meetings?.[target.date] && !Object.keys(drafts.meetings[target.date]).length) delete drafts.meetings[target.date];
        writeDrafts(drafts);
        return operationResponse(request, { ok: false, code: "SHEET_CHANGED", error: "Google Sheets changed first. The latest sheet data has been loaded. You can edit this item after 1 minute.", conflicts: sheetConflicts, sheetValues });
      }
      const sectionLocks = drafts.locks?.[target.date]?.[request.section] || {};
      Object.keys(updates).forEach(label => {
        if (Number(sectionLocks[label] || 0) > now) {
          throw new Error("Someone edited this item first. You can change it after 20 seconds.");
        }
      });
      if (!drafts.meetings[target.date]) drafts.meetings[target.date] = {};
      if (!drafts.bases[target.date]) drafts.bases[target.date] = {};
      if (!drafts.bases[target.date][request.section]) drafts.bases[target.date][request.section] = {};
      const sectionDraft = { ...(drafts.meetings[target.date][request.section] || {}) };
      Object.entries(updates).forEach(([label, value]) => {
        const row = context.rowByLabel.get(label);
        if (!row) throw new Error(`Row was not found: ${label}`);
        const sheetValue = String(context.sheet.getRange(row, target.column).getValue() ?? "").trim();
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
      if (!drafts.locks[target.date]) drafts.locks[target.date] = {};
      if (!drafts.locks[target.date][request.section]) drafts.locks[target.date][request.section] = {};
      Object.keys(updates).forEach(label => { drafts.locks[target.date][request.section][label] = now + 20000; });
      const saved = writeDrafts(drafts);
      appendAudit(Object.entries(updates).map(([label, value]) => ({ at: new Date().toISOString(), action: "draft", meetingDate: target.date, section: request.section, label, value, revision: saved.fieldVersions[fieldKey(target.date, request.section, label)] })));
      return operationResponse(request, { ok: true, draft: true, revision: saved.revision, fieldVersions: saved.fieldVersions, updated: Object.keys(updates).length });
    }

    if (request.action === "applyDrafts") {
      requirePin(request.pin);
      const drafts = readDrafts();
      const conflicts = [];
      const writes = [];
      const allEntries = [];
      const requestedSelections = Array.isArray(request.selections) ? request.selections : null;
      const selectedKeys = requestedSelections === null ? null : new Set(requestedSelections.map(item =>
        fieldKey(String(item?.meetingDate || ""), String(item?.section || ""), String(item?.label || ""))));
      Object.entries(drafts.meetings || {}).forEach(([meetingDate, sections]) => {
        const target = requireAllowedMeeting(context, meetingDate);
        Object.entries(sections || {}).forEach(([section, rawUpdates]) => {
          const updates = validatedUpdates(section, rawUpdates);
          Object.keys(updates).forEach(label => {
            const key = fieldKey(meetingDate, section, label);
            allEntries.push({ meetingDate, section, label, value: updates[label] });
            if (selectedKeys && !selectedKeys.has(key)) return;
            const row = context.rowByLabel.get(label);
            if (!row) throw new Error(`Row was not found: ${label}`);
            const currentValue = String(context.sheet.getRange(row, target.column).getValue() ?? "").trim();
            const baseValue = String(drafts.bases?.[meetingDate]?.[section]?.[label] ?? currentValue).trim();
            if (currentValue !== baseValue) conflicts.push({ meetingDate, section, label, sheetValue: currentValue, draftValue: updates[label] });
            writes.push({ meetingDate, section, label, row, column: target.column, previousValue: currentValue, value: updates[label] });
          });
        });
      });
      if (conflicts.length && request.force !== true) {
        return operationResponse(request, { ok: false, code: "SHEET_CHANGED", error: "Google Sheets changed after the shared draft was created.", conflicts });
      }
      let completed = 0;
      try {
        writes.forEach(item => {
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
      drafts.meetings = {};
      drafts.bases = {};
      const now = Date.now();
      Object.keys(drafts.locks || {}).forEach(date => {
        Object.keys(drafts.locks[date] || {}).forEach(section => {
          Object.keys(drafts.locks[date][section] || {}).forEach(label => {
            if (Number(drafts.locks[date][section][label] || 0) <= now) delete drafts.locks[date][section][label];
          });
        });
      });
      const saved = writeDrafts(drafts);
      const appliedKeys = new Set(writes.map(item => fieldKey(item.meetingDate, item.section, item.label)));
      const discarded = allEntries.filter(item => !appliedKeys.has(fieldKey(item.meetingDate, item.section, item.label)));
      appendAudit([
        ...writes.map(item => ({ at: new Date().toISOString(), action: request.force === true ? "force-apply" : "apply", meetingDate: item.meetingDate, section: item.section, label: item.label, from: item.previousValue, value: item.value })),
        ...discarded.map(item => ({ at: new Date().toISOString(), action: "discard", meetingDate: item.meetingDate, section: item.section, label: item.label, value: item.value })),
      ]);
      return operationResponse(request, { ok: true, applied: true, revision: saved.revision, updated: writes.length, discarded: discarded.length });
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
