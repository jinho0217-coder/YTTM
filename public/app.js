const state = { model: null, member: "all", role: "all", meetingView: "coming", sharedDrafts: { revision: 0, updatedAt: "", meetings: {}, locks: {}, fieldVersions: {} }, sheetBaseValues: {} };
const SHEET_ID = "1arhgy3QSwHxyM9gBy6nXdw76N-94R53kf0ogV4Nq2lA";
const SHEET_SOURCE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=1852116681`;
const WRITE_ENDPOINT = clean(window.YTTM_CONFIG?.writeEndpoint);
const THEME_EDIT_FIELDS = ["Theme", "Theme Question", "Word of the day", "Quote of the day"];
const ROLE_EDIT_FIELDS = [
  "Chairperson", "Toastmaster", "General Evaluator", "Table Topic Master", "Timer",
  "Ah Counter", "Grammarian", "Word & Quote Master", "Quiz Master", "Table Topic Evaluator",
];

async function apiRequest(payload) {
  if (!WRITE_ENDPOINT) throw new Error("The shared draft service is not configured.");
  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  await fetch(WRITE_ENDPOINT, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ ...payload, requestId }),
  });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await jsonpRequest("status", { requestId });
    if (!result.pending) {
      if (!result.ok) {
        const error = new Error(result.error || "The request was rejected.");
        error.result = result;
        throw error;
      }
      return result;
    }
  }
  throw new Error("The shared draft service did not confirm the request.");
}

function jsonpRequest(action, parameters = {}) {
  if (!WRITE_ENDPOINT) return Promise.reject(new Error("The shared draft service is not configured."));
  return new Promise((resolve, reject) => {
    const callback = `yttmJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const timeout = setTimeout(() => finish(new Error("The shared draft service timed out.")), 10000);
    const finish = (error, value) => {
      clearTimeout(timeout);
      delete window[callback];
      script.remove();
      if (error) reject(error); else resolve(value);
    };
    window[callback] = value => finish(null, value);
    script.onerror = () => finish(new Error("Unable to reach the shared draft service."));
    const query = new URLSearchParams({ action, callback, _: Date.now(), ...parameters });
    script.src = `${WRITE_ENDPOINT}?${query}`;
    document.head.appendChild(script);
  });
}

async function fetchSharedDrafts() {
  if (!WRITE_ENDPOINT) return { revision: 0, updatedAt: "", meetings: {}, locks: {}, fieldVersions: {} };
  const result = await jsonpRequest("getDrafts");
  if (!result.ok) throw new Error(result.error || "Unable to load shared drafts.");
  return result.drafts || { revision: 0, updatedAt: "", meetings: {}, locks: {}, fieldVersions: {} };
}

function sharedDraftEntries() {
  return Object.entries(state.sharedDrafts.meetings || {}).flatMap(([meetingDate, sections]) =>
    Object.entries(sections || {}).flatMap(([section, updates]) =>
      Object.entries(updates || {}).map(([label, value]) => ({ meetingDate, section, label, value }))));
}

function renderDraftSyncState() {
  const entries = sharedDraftEntries();
  const badge = document.getElementById("draftSyncBadge");
  const button = document.getElementById("applySheetsButton");
  const pending = entries.length > 0;
  badge.className = `draft-sync-badge ${pending ? "pending" : "synced"}`;
  badge.textContent = pending ? `Shared draft pending · ${entries.length}` : "Google Sheet synced";
  button.classList.toggle("pending", pending);
  button.disabled = !pending;
  button.textContent = pending ? `Apply ${entries.length} change${entries.length === 1 ? "" : "s"}` : "Google Sheet up to date";
}

function applySharedDraftsToRows(rolesRows, drafts) {
  const dateColumns = new Map((rolesRows[0] || []).map((value, col) => [clean(value), col]));
  const rows = rowMap(rolesRows);
  Object.entries(drafts.meetings || {}).forEach(([meetingDate, sections]) => {
    const col = dateColumns.get(meetingDate);
    if (col == null) return;
    Object.values(sections || {}).forEach(updates => {
      Object.entries(updates || {}).forEach(([label, value]) => {
        const target = rows.get(label)?.row;
        if (target) target[col] = value;
      });
    });
  });
}

function captureSheetBaseValues(rolesRows) {
  const dates = rolesRows[0] || [];
  const values = {};
  rolesRows.slice(1).forEach(row => {
    const label = clean(row[0]);
    if (!label) return;
    for (let col = 1; col < dates.length; col += 1) {
      const meetingDate = clean(dates[col]);
      if (!meetingDate) continue;
      values[meetingDate] ||= {};
      values[meetingDate][label] = clean(row[col]);
    }
  });
  state.sheetBaseValues = values;
}

async function fetchPublicSheets() {
  const base = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`;
  const stamp = Date.now();
  const [rolesResponse, agendaResponse] = await Promise.all([
    fetch(`${base}?gid=1852116681&tqx=out%3Acsv&_=${stamp}`, { cache: "no-store" }),
    fetch(`${base}?sheet=26_Agenda&tqx=out%3Acsv&_=${stamp}`, { cache: "no-store" }),
  ]);
  if (!rolesResponse.ok || !agendaResponse.ok) {
    throw new Error(`Google Sheets returned ${rolesResponse.status}/${agendaResponse.status}`);
  }
  return {
    rolesCsv: await rolesResponse.text(),
    agendaCsv: await agendaResponse.text(),
    fetchedAt: new Date().toISOString(),
    source: SHEET_SOURCE,
  };
}

function setActiveTab(tabName, updateHash = true, scrollToTop = true) {
  const validTabs = new Set(["past", "coming", "next"]);
  const activeTab = validTabs.has(tabName) ? tabName : "coming";
  state.meetingView = activeTab;
  document.querySelectorAll("[data-dashboard-tab]").forEach(button => {
    button.setAttribute("aria-selected", String(button.dataset.dashboardTab === activeTab));
  });
  document.querySelectorAll("[data-tab-panel]").forEach(panel => {
    panel.hidden = panel.dataset.tabPanel !== "week";
  });
  if (state.model) renderThisWeek(state.model);
  if (updateHash) {
    const hashes = { past: "#past-meeting", coming: "#coming-up", next: "#next-meeting" };
    history.replaceState(null, "", hashes[activeTab]);
  }
  if (scrollToTop) window.scrollTo({ top: 0, behavior: "smooth" });
}

const ROLE_LABELS = [
  "Chairperson", "Toastmaster", "General Evaluator", "Table Topic Master",
  "Timer", "Ah Counter", "Grammarian", "Word & Quote Master", "Quiz Master",
  "Table Topic Evaluator", "Speaker", "Evaluator",
];

const AGENDA_FALLBACK = [
  ["09:50", "Icebreaking", "Members & guests"],
  ["10:00", "Introduction", "Chairperson"],
  ["10:05", "Toastmaster's Session", "Theme & role introductions"],
  ["10:20", "Prepared Speech Session", "Speakers & evaluators"],
  ["10:50", "Q & A Session", "Questions to speakers"],
  ["11:00", "Break", "10 minutes"],
  ["11:10", "Table Topics", "Impromptu speaking"],
  ["11:30", "Evaluation Session", "Evaluations & reports"],
  ["11:55", "Announcement Session", "Awards & announcements"],
  ["12:00", "Closing", "Chairperson"],
];

function parseCsv(text) {
  const rows = [];
  let row = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(value); value = ""; }
    else if (char === "\n") { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += char;
  }
  if (value || row.length) { row.push(value.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

function clean(value) { return String(value ?? "").trim(); }
function normalizeName(value) {
  let name = clean(value).replace(/\s*\([^)]*\)\s*$/, "").trim();
  const aliases = { Shilry: "Shirly", EunJeong: "Eunjeong", "Q-Sun": "Q Sun", Stella: "Stella Yang" };
  name = aliases[name] || name;
  const blocked = /^(no meeting|education|speech contest|area |division |district |february|[-~])|session$/i;
  return !name || blocked.test(name) ? "" : name;
}
function parseDate(value) {
  const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00+09:00`) : null;
}
function todayKst(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return new Date(`${map.year}-${map.month}-${map.day}T00:00:00+09:00`);
}
function meetingReferenceDateKst(now = new Date()) {
  const today = todayKst(now);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  if (map.weekday === "Sun" && Number(map.hour) >= 13) {
    return new Date(today.getTime() + 24 * 60 * 60 * 1000);
  }
  return today;
}
function formatDate(date, options = {}) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "short", ...options }).format(date);
}
function formatMeetingDate(date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" }).format(date);
}
function sheetDateValue(date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}
function canonicalRole(label) {
  const value = clean(label);
  if (/^Speaker \d+$/i.test(value)) return "Speaker";
  if (/^Evaluator \d+$/i.test(value)) return "Evaluator";
  const map = {
    "Table Topic Master": "Table Topic Master",
    "Table Topics Master": "Table Topic Master",
    "Ah counter": "Ah Counter",
    "Table Topic evaluator": "Table Topic Evaluator",
  };
  return map[value] || value;
}
function isRoleRow(label) { return ROLE_LABELS.includes(canonicalRole(label)); }
function rowMap(rows) { return new Map(rows.map((row, index) => [clean(row[0]), { row, index }])); }

function buildModel(rolesRows, agendaRows) {
  const rowsByLabel = rowMap(rolesRows);
  const dates = rolesRows[0] || [];
  const meetingNos = rolesRows[1] || [];
  const today = todayKst();
  const meetingReferenceDate = meetingReferenceDateKst();
  const columns = [];
  for (let col = 1; col < dates.length; col += 1) {
    const date = parseDate(dates[col]);
    if (!date) continue;
    const special = clean(rowsByLabel.get("Special Event")?.row[col]);
    const chair = clean(rowsByLabel.get("Chairperson")?.row[col]);
    const noMeeting = /no meeting/i.test(`${special} ${chair}`);
    columns.push({ col, date, meetingNo: clean(meetingNos[col]), special, noMeeting });
  }

  const completedColumns = columns.filter(c => c.date < meetingReferenceDate && !c.noMeeting).filter(c => {
    const anchors = ["Chairperson", "Toastmaster", "General Evaluator", "Speaker 1"];
    return anchors.filter(label => clean(rowsByLabel.get(label)?.row[c.col])).length >= 3;
  });
  const completedSet = new Set(completedColumns.map(c => c.col));
  const pastMeeting = columns.filter(c => c.date < meetingReferenceDate && !c.noMeeting).at(-1) || null;
  const upcomingMeetings = columns.filter(c => c.date >= meetingReferenceDate && !c.noMeeting);
  const comingMeeting = upcomingMeetings[0] || columns.filter(c => !c.noMeeting).at(-1);
  const followingMeeting = upcomingMeetings[1] || null;
  const assignments = [];
  const speeches = [];

  rolesRows.forEach(row => {
    const sourceLabel = clean(row[0]);
    if (!isRoleRow(sourceLabel)) return;
    const role = canonicalRole(sourceLabel);
    completedColumns.forEach(column => {
      const member = normalizeName(row[column.col]);
      if (!member) return;
      assignments.push({ member, role, sourceLabel, date: column.date, meetingNo: column.meetingNo, col: column.col });
    });
  });

  for (let number = 1; number <= 4; number += 1) {
    const speakerRow = rowsByLabel.get(`Speaker ${number}`)?.row || [];
    const projectRow = rowsByLabel.get(`Project ${number}`)?.row || [];
    const titleRow = rowsByLabel.get(`Title ${number}`)?.row || [];
    const timeRow = rowsByLabel.get(`Time ${number}`)?.row || [];
    const evaluatorRow = rowsByLabel.get(`Evaluator ${number}`)?.row || [];
    completedColumns.forEach(column => {
      const speaker = normalizeName(speakerRow[column.col]);
      if (!speaker) return;
      speeches.push({
        speaker,
        date: column.date,
        meetingNo: column.meetingNo,
        slot: number,
        project: clean(projectRow[column.col]),
        title: clean(titleRow[column.col]) || "Untitled speech",
        time: clean(timeRow[column.col]),
        evaluator: normalizeName(evaluatorRow[column.col]),
      });
    });
  }

  const members = new Map();
  assignments.forEach(item => {
    if (!members.has(item.member)) members.set(item.member, { name: item.member, roles: [], speeches: [] });
    members.get(item.member).roles.push(item);
  });
  speeches.forEach(item => {
    if (!members.has(item.speaker)) members.set(item.speaker, { name: item.speaker, roles: [], speeches: [] });
    members.get(item.speaker).speeches.push(item);
  });

  return {
    today, rowsByLabel, columns, completedColumns, completedSet, pastMeeting, comingMeeting, followingMeeting,
    assignments, speeches, members: [...members.values()], agenda: extractAgenda(agendaRows),
  };
}

function extractAgenda(rows) {
  const items = rows.flatMap(row => {
    const time = clean(row[1]);
    const description = clean(row[2]);
    if (!/^\d{1,2}:\d{2}$/.test(time) || !description) return [];
    const title = description.replace(/^\[\s*\d+mins?\]\s*/i, "").trim();
    return [[time.padStart(5, "0"), title, "26_Agenda"]];
  });
  const unique = [...new Map(items.map(item => [`${item[0]}-${item[1]}`, item])).values()];
  return unique.length >= 6 ? unique : AGENDA_FALLBACK;
}

function detailedAgenda(model, meeting) {
  const memberFor = label => normalizeName(model.rowsByLabel.get(label)?.row[meeting.col]) || "Pending";
  const combinedMembers = labels => [...new Set(labels.map(memberFor))].join(" / ");
  const speeches = [];
  for (let number = 1; number <= 4; number += 1) {
    const speaker = normalizeName(model.rowsByLabel.get(`Speaker ${number}`)?.row[meeting.col]);
    if (number > 1 && !speaker) continue;
    speeches.push([
      speaker || "Pending",
      clean(model.rowsByLabel.get(`Project ${number}`)?.row[meeting.col]) || "Pending",
      clean(model.rowsByLabel.get(`Title ${number}`)?.row[meeting.col]) || "Pending",
      clean(model.rowsByLabel.get(`Time ${number}`)?.row[meeting.col]) || "Pending",
      normalizeName(model.rowsByLabel.get(`Evaluator ${number}`)?.row[meeting.col]) || "Pending",
    ]);
  }
  return [
    {
      time: "10:00", title: "Chair Calls Meeting to Order", ownerRole: "Chairperson", owner: memberFor("Chairperson"),
      bullets: ["Chair's Welcome", "Read Mission Statement", "Introduction of Toastmasters Club Meeting"],
    },
    {
      time: "10:05", title: "Toastmaster Calls on Meeting Roles", ownerRole: "Toastmaster", owner: memberFor("Toastmaster"),
      table: {
        headers: ["Role", "Person"],
        rows: [
          ["General Evaluator", memberFor("General Evaluator")],
          ["Table Topic Evaluator", memberFor("Table Topic Evaluator")],
          ["Grammarian + The Word and Quote Master", combinedMembers(["Grammarian", "Word & Quote Master"])],
          ["Ah-Counter", memberFor("Ah Counter")],
          ["Timer", memberFor("Timer")],
          ["Quiz Master", memberFor("Quiz Master")],
        ],
      },
    },
    {
      time: "10:20", title: "Prepared Speech Session", ownerRole: "Toastmaster", owner: memberFor("Toastmaster"),
      table: { headers: ["Speaker", "Project", "Speech Title", "Time", "Evaluator"], rows: speeches },
      note: "1 min silence after each speech",
    },
    {
      time: "10:50", title: "Break", owner: "",
      bullets: ["Deliver feedback to speaker and transfer meeting fee (check left account information)"],
    },
    {
      time: "11:00", title: "Table Topic Session", ownerRole: "Table Topic Master", owner: memberFor("Table Topic Master"),
      bullets: ["Conduct Table Topics Session", "Call for Timer's Report", "Recap Speakers and Give Reminder to Vote"],
    },
    {
      time: "11:30", title: "Evaluation Session", ownerRole: "General Evaluator", owner: memberFor("General Evaluator"),
      bullets: ["Speech Evaluation (2-3 min per speech)", "Call for Timer's Report"],
      table: {
        headers: ["Report", "Person"],
        rows: [
          ["Ah-Counter's report", memberFor("Ah Counter")],
          ["Grammarian's report", memberFor("Grammarian")],
          ["Table Topic Evaluator", memberFor("Table Topic Evaluator")],
          ["Quiz Master", memberFor("Quiz Master")],
          ["General Evaluator's report", memberFor("General Evaluator")],
        ],
      },
    },
    {
      time: "11:50", title: "Awards Session", ownerRole: "Toastmaster", owner: memberFor("Toastmaster"),
      bullets: ["Awards", "Closing remarks"],
    },
    {
      time: "11:55", title: "Closing", ownerRole: "Chairperson", owner: memberFor("Chairperson"),
      bullets: ["Next Meeting", "Announcement and Meeting Role Sign-up", "Guest Feedback and Group Photo"],
    },
  ];
}

function agendaDetailHtml(item) {
  const owner = item.owner ? `<p class="agenda-dialog-owner">${escapeHtml(item.ownerRole || "Host")} · <strong>${escapeHtml(item.owner)}</strong></p>` : "";
  const bullets = item.bullets?.length
    ? `<ul class="agenda-bullets">${item.bullets.map(bullet => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`
    : "";
  const isSpeechTable = item.table?.headers.length > 2;
  const table = item.table
    ? `<div class="agenda-table-wrap ${isSpeechTable ? "speech-agenda-table-wrap" : ""}"><table class="agenda-table ${isSpeechTable ? "speech-agenda-table" : ""}"><thead><tr>${item.table.headers.map(header => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${item.table.rows.map(row => `<tr>${row.map((value, index) => `<td data-label="${escapeHtml(item.table.headers[index])}" class="${value === "Pending" ? "pending" : ""}">${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
    : "";
  const note = item.note ? `<p class="agenda-note">${escapeHtml(item.note)}</p>` : "";
  return `${owner}${bullets}${table}${note}`;
}

function renderCompactAgenda(model, meeting) {
  const items = detailedAgenda(model, meeting);
  const container = document.getElementById("agendaTimeline");
  container.innerHTML = items.map((item, index) => {
    const summary = item.owner ? `${item.ownerRole || "Host"} · ${item.owner}` : "Open session details";
    return `<button type="button" class="agenda-item agenda-item-button" data-agenda-index="${index}" aria-haspopup="dialog"><span class="agenda-time">${escapeHtml(item.time)}</span><span class="agenda-line"></span><span class="agenda-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(summary)}</small></span></button>`;
  }).join("");
  container.querySelectorAll("[data-agenda-index]").forEach(button => {
    const item = items[Number(button.dataset.agendaIndex)];
    button.addEventListener("click", () => showAgendaDetails(item));
    const details = [
      `${item.time} · ${item.title}`,
      item.owner ? `${item.ownerRole || "Host"}: ${item.owner}` : "",
      ...(item.bullets || []).map(bullet => `• ${bullet}`),
      ...(item.table?.rows || []).slice(0, 8).map(row => `• ${row.join(" · ")}`),
      item.note || "",
      "Click for full details.",
    ].filter(Boolean).join("\n");
    addTooltip(button, details, "detail");
  });
}

function showAgendaDetails(item) {
  configureDetailsEditor();
  setText("agendaDialogEyebrow", item.time);
  setText("agendaDialogTitle", item.title);
  document.getElementById("agendaDialogDetails").innerHTML = agendaDetailHtml(item);
  document.getElementById("agendaDetailsDialog").showModal();
}

function configureDetailsEditor(section = "", field = "") {
  const actions = document.getElementById("agendaDialogActions");
  const button = document.getElementById("agendaDialogEditButton");
  const editable = Boolean(section) && state.meetingView !== "past";
  if (!actions.contains(button)) actions.appendChild(button);
  button.dataset.editSection = section;
  button.dataset.editField = field;
  const inlineSlot = document.querySelector("#agendaDialogDetails [data-inline-edit-slot]");
  if (editable && inlineSlot) inlineSlot.appendChild(button);
  actions.classList.toggle("hidden", !editable || Boolean(inlineSlot));
  button.classList.toggle("inline-detail-edit", Boolean(inlineSlot));
  button.hidden = !editable;
}

const ROLE_AGENDA_DUTIES = {
  Chairperson: [
    ["10:00", "Call the meeting to order, welcome members and guests, read the mission statement, and introduce the club meeting."],
    ["11:55", "Close the meeting with the next meeting notice, announcements, role sign-up, guest feedback, and group photo."],
  ],
  Toastmaster: [
    ["10:05", "Call on meeting role holders and introduce the meeting team."],
    ["10:20", "Conduct the Prepared Speech Session and introduce each speaker."],
    ["11:50", "Conduct the Awards Session and deliver closing remarks."],
  ],
  "General Evaluator": [
    ["11:30", "Conduct the Evaluation Session, call speech evaluators and role reports, and deliver the General Evaluator's report."],
  ],
  "Table Topic Master": [
    ["11:00", "Conduct the Table Topic Session, call for the Timer's report, recap speakers, and remind members to vote."],
  ],
  Timer: [
    ["10:05", "Explain timing rules and timing signals for prepared speeches, Table Topics, and evaluations."],
    ["11:00 / 11:30", "Deliver the Timer's reports when called during the Table Topic and Evaluation Sessions."],
  ],
  "Ah Counter": [
    ["10:05", "Explain the role and listen for filler words and unnecessary sounds throughout the meeting."],
    ["11:30", "Deliver the Ah-Counter's report during the Evaluation Session."],
  ],
  Grammarian: [
    ["10:05", "Introduce the language focus and listen for effective or incorrect language usage."],
    ["11:30", "Deliver the Grammarian's report during the Evaluation Session."],
  ],
  "Word & Quote Master": [
    ["10:05", "Introduce the Word of the Day and Quote of the Day, including meaning and usage."],
    ["11:30", "Report how the Word of the Day was used during the meeting."],
  ],
  "Quiz Master": [
    ["10:05", "Explain the listening quiz and note important details throughout the meeting."],
    ["11:30", "Conduct the quiz and deliver the Quiz Master's report."],
  ],
  "Table Topic Evaluator": [
    ["11:00", "Observe Table Topic speakers and prepare concise feedback."],
    ["11:30", "Deliver the Table Topic evaluation during the Evaluation Session."],
  ],
};

function showRoleDetails(assignment) {
  configureDetailsEditor();
  const duties = ROLE_AGENDA_DUTIES[assignment.role] || [["Agenda", "Support the meeting according to the Toastmaster's instructions."]];
  setText("agendaDialogEyebrow", "ROLE RESPONSIBILITIES");
  setText("agendaDialogTitle", assignment.role);
  document.getElementById("agendaDialogDetails").innerHTML = `
    <div class="agenda-dialog-owner-row"><p class="agenda-dialog-owner">Assigned to · <strong>${escapeHtml(assignment.member)}</strong></p><span data-inline-edit-slot></span></div>
    <ul class="role-duty-list">${duties.map(([time, duty]) => `<li><time>${escapeHtml(time)}</time><span>${escapeHtml(duty)}</span></li>`).join("")}</ul>`;
  configureDetailsEditor("roles", assignment.role);
  document.getElementById("agendaDetailsDialog").showModal();
}

function showThemeDetails(label, value) {
  configureDetailsEditor();
  setText("agendaDialogEyebrow", "MEETING THEME");
  setText("agendaDialogTitle", label);
  document.getElementById("agendaDialogDetails").innerHTML = `<div class="theme-detail-row"><div class="theme-detail-value ${value ? "" : "pending"}">${escapeHtml(value || "Pending")}</div><span data-inline-edit-slot></span></div>`;
  configureDetailsEditor("theme", label);
  document.getElementById("agendaDetailsDialog").showModal();
}

let suppressLongPressClickUntil = 0;
function addMobileLongPress(element, openEditor) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    element.classList.remove("long-pressing");
  };
  element.addEventListener("touchstart", event => {
    if (event.touches.length !== 1 || state.meetingView === "past" || window.innerWidth > 700) return;
    const touch = event.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    timer = window.setTimeout(() => {
      timer = null;
      element.classList.remove("long-pressing");
      suppressLongPressClickUntil = Date.now() + 700;
      navigator.vibrate?.(35);
      openEditor();
    }, 550);
    window.setTimeout(() => { if (timer) element.classList.add("long-pressing"); }, 260);
  }, { passive: true });
  element.addEventListener("touchmove", event => {
    if (!timer || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > 10) cancel();
  }, { passive: true });
  element.addEventListener("touchend", cancel, { passive: true });
  element.addEventListener("touchcancel", cancel, { passive: true });
  element.addEventListener("contextmenu", event => {
    if (window.innerWidth <= 700) event.preventDefault();
  });
}

function activeMeeting() {
  if (!state.model) return null;
  return state.meetingView === "coming" ? state.model.comingMeeting : state.meetingView === "next" ? state.model.followingMeeting : state.model.pastMeeting;
}

function editableValue(meeting, label) {
  return clean(state.model.rowsByLabel.get(label)?.row[meeting.col]);
}

function editFieldHtml(meeting, label) {
  const value = editableValue(meeting, label);
  const id = `edit-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return `<label class="meeting-edit-field" for="${id}"><span>${escapeHtml(label)}</span><div><input id="${id}" name="${escapeHtml(label)}" data-edit-field="${escapeHtml(label)}" data-initial-value="${escapeHtml(value)}" value="${escapeHtml(value)}" maxlength="500" autocomplete="off"><button type="button" class="clear-field-button" data-clear-field="${escapeHtml(label)}" aria-label="Clear ${escapeHtml(label)}">Clear</button></div></label>`;
}

let meetingLockTimer = null;

function updateMeetingFieldLocks() {
  clearInterval(meetingLockTimer);
  const meeting = state.editMeeting;
  if (!meeting) return;
  const meetingDate = sheetDateValue(meeting.date);
  const locks = state.sharedDrafts.locks?.[meetingDate]?.[state.editSection] || {};
  const status = document.getElementById("meetingEditStatus");
  const refreshLocks = () => {
    const now = Date.now();
    let longest = 0;
    document.querySelectorAll("#meetingEditFields [data-edit-field]").forEach(input => {
      const remaining = Math.max(0, Math.ceil((Number(locks[input.dataset.editField] || 0) - now) / 1000));
      const field = input.closest(".meeting-edit-field");
      const clearButton = field?.querySelector("[data-clear-field]");
      input.disabled = remaining > 0;
      if (clearButton) clearButton.disabled = remaining > 0;
      field?.classList.toggle("locked", remaining > 0);
      longest = Math.max(longest, remaining);
    });
    if (longest > 0) {
      status.className = "meeting-edit-status locked";
      status.textContent = `Someone edited this item first. You can change it after ${longest} second${longest === 1 ? "" : "s"}.`;
      document.getElementById("saveMeetingEdit").disabled = true;
    } else {
      clearInterval(meetingLockTimer);
      meetingLockTimer = null;
      status.className = "meeting-edit-status";
      status.textContent = "This will update the shared draft, not Google Sheets.";
      updateMeetingEditorState();
    }
  };
  refreshLocks();
  if ([...document.querySelectorAll("#meetingEditFields [data-edit-field]")].some(input => input.disabled)) {
    meetingLockTimer = setInterval(refreshLocks, 1000);
  }
}

function openMeetingEditor(section, field = "", speechSlot = null) {
  const meeting = activeMeeting();
  if (!meeting || state.meetingView === "past") return;
  state.editSection = section;
  state.editMeeting = meeting;
  const titles = { theme: "Meeting theme", roles: "Role assignments", speeches: "Prepared speeches" };
  setText("meetingEditEyebrow", `${formatMeetingDate(meeting.date)} MEETING · ${meeting.meetingNo || ""}`);
  setText("meetingEditTitle", `Edit ${speechSlot ? `Speaker ${speechSlot} speech` : field || titles[section]}`);
  let content = "";
  if (section === "theme") {
    const fields = field && THEME_EDIT_FIELDS.includes(field) ? [field] : THEME_EDIT_FIELDS;
    content = fields.map(label => editFieldHtml(meeting, label)).join("");
  }
  if (section === "roles") {
    const fields = field && ROLE_EDIT_FIELDS.includes(field) ? [field] : ROLE_EDIT_FIELDS;
    content = fields.map(label => editFieldHtml(meeting, label)).join("");
  }
  if (section === "speeches") {
    const slots = speechSlot ? [Number(speechSlot)] : [1, 2, 3, 4];
    content = slots.map(number => `<fieldset class="speech-edit-group"><legend>Speaker ${number}</legend>${[
      `Speaker ${number}`, `Project ${number}`, `Title ${number}`, `Time ${number}`, `Evaluator ${number}`,
    ].map(label => editFieldHtml(meeting, label)).join("")}</fieldset>`).join("");
  }
  document.getElementById("meetingEditFields").innerHTML = content;
  setText("meetingEditStatus", WRITE_ENDPOINT ? "This will update the shared draft, not Google Sheets." : "Shared draft saving is not configured.");
  document.getElementById("saveMeetingEdit").disabled = true;
  document.getElementById("meetingEditDialog").showModal();
  updateMeetingFieldLocks();
}

function updateMeetingEditorState() {
  const inputs = [...document.querySelectorAll("#meetingEditFields [data-edit-field]:not(:disabled)")];
  const changed = inputs.some(input => input.value.trim() !== input.dataset.initialValue);
  document.getElementById("saveMeetingEdit").disabled = !changed;
}

function setMeetingSaveBusy(busy) {
  const dialog = document.getElementById("meetingEditDialog");
  const saveButton = document.getElementById("saveMeetingEdit");
  const progress = document.getElementById("meetingSaveProgress");
  dialog.classList.toggle("is-saving", busy);
  dialog.setAttribute("aria-busy", String(busy));
  progress.classList.toggle("active", busy);
  progress.setAttribute("aria-hidden", String(!busy));
  saveButton.classList.toggle("saving", busy);
  saveButton.querySelector(".save-button-label").textContent = busy ? "Saving…" : "Save changes";
  document.getElementById("cancelMeetingEdit").disabled = busy;
  document.getElementById("closeMeetingEditDialog").disabled = busy;
}

async function saveMeetingEditor(event) {
  event.preventDefault();
  if (!state.editMeeting || state.meetingView === "past") return;
  const saveButton = document.getElementById("saveMeetingEdit");
  const status = document.getElementById("meetingEditStatus");
  if (!WRITE_ENDPOINT) {
    status.className = "meeting-edit-status error";
    status.textContent = "The shared draft service is not connected.";
    return;
  }
  const updates = Object.fromEntries([...document.querySelectorAll("#meetingEditFields [data-edit-field]")]
    .filter(input => input.value.trim() !== input.dataset.initialValue)
    .map(input => [input.dataset.editField, input.value.trim()]));
  const meetingDate = sheetDateValue(state.editMeeting.date);
  const baseValues = Object.fromEntries(Object.keys(updates).map(label => [label, state.sheetBaseValues[meetingDate]?.[label] || ""]));
  const fieldVersions = Object.fromEntries(Object.keys(updates).map(label => [label, Number(state.sharedDrafts.fieldVersions?.[`${meetingDate}|${state.editSection}|${label}`] || 0)]));
  saveButton.disabled = true;
  setMeetingSaveBusy(true);
  status.className = "meeting-edit-status";
  status.textContent = "Saving to the shared draft… Please keep this window open.";
  try {
    const result = await apiRequest({
      action: "saveDraft",
      meetingDate,
      section: state.editSection,
      updates,
      baseValues,
      fieldVersions,
    });
    status.className = "meeting-edit-status success";
    status.textContent = `Draft saved. Updating everyone’s view…`;
    await loadDashboard(true);
    status.textContent = `Saved ${result.updated} shared draft field${result.updated === 1 ? "" : "s"}.`;
    closeMeetingEditor();
  } catch (error) {
    if (error.result?.code === "SHEET_CHANGED" || error.result?.code === "DRAFT_CHANGED") {
      closeMeetingEditor();
      await loadDashboard(true);
      const banner = document.getElementById("statusBanner");
      banner.className = "status-banner warning";
      banner.textContent = error.result.code === "SHEET_CHANGED"
        ? "Google Sheets changed first. The latest sheet data is now shown. You can edit the affected item after 1 minute."
        : "Another person changed this item while you were editing. Their latest shared value is now shown; your entry was not overwritten.";
      return;
    }
    status.className = "meeting-edit-status error";
    status.textContent = `Unable to save: ${error.message}`;
  } finally {
    setMeetingSaveBusy(false);
    if (document.getElementById("meetingEditDialog").open) updateMeetingEditorState();
  }
}

function openAdminApplyDialog() {
  const entries = sharedDraftEntries();
  if (!entries.length) return;
  const meetings = new Set(entries.map(entry => entry.meetingDate)).size;
  setText("adminApplySummary", `${entries.length} shared change${entries.length === 1 ? "" : "s"} across ${meetings} meeting${meetings === 1 ? "" : "s"} will be written to Google Sheets.`);
  const status = document.getElementById("adminApplyStatus");
  status.className = "meeting-edit-status";
  status.textContent = "Enter the administrator PIN to apply all shared changes.";
  document.getElementById("adminApplyPin").value = "";
  const applyButton = document.getElementById("confirmApplySheets");
  applyButton.dataset.force = "";
  applyButton.textContent = "Apply changes";
  document.getElementById("adminApplyDialog").showModal();
}

async function applySharedDrafts(event) {
  event.preventDefault();
  const pin = document.getElementById("adminApplyPin").value;
  const status = document.getElementById("adminApplyStatus");
  const button = document.getElementById("confirmApplySheets");
  if (!/^\d{4}$/.test(pin)) {
    status.className = "meeting-edit-status error";
    status.textContent = "Enter a 4-digit administrator PIN.";
    return;
  }
  button.disabled = true;
  status.className = "meeting-edit-status";
  status.textContent = "Applying the shared draft to Google Sheets…";
  try {
    const result = await apiRequest({ action: "applyDrafts", pin, force: button.dataset.force === "true" });
    status.className = "meeting-edit-status success";
    status.textContent = `Applied ${result.updated} field${result.updated === 1 ? "" : "s"} to Google Sheets.`;
    await loadDashboard(true);
    setTimeout(() => document.getElementById("adminApplyDialog").close(), 700);
  } catch (error) {
    if (error.result?.code === "SHEET_CHANGED") {
      const conflicts = error.result.conflicts || [];
      status.className = "meeting-edit-status warning";
      status.textContent = `Warning: Google Sheets changed after the draft was created (${conflicts.map(item => `${item.meetingDate} · ${item.label}`).join(", ")}). Review the sheet first, then click Apply anyway to overwrite it.`;
      button.dataset.force = "true";
      button.textContent = "Apply anyway";
      return;
    }
    status.className = "meeting-edit-status error";
    status.textContent = `Unable to apply: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function changeAdministratorPin(event) {
  event.preventDefault();
  const currentPin = document.getElementById("currentAdminPin").value;
  const newPin = document.getElementById("newAdminPin").value;
  const confirmPin = document.getElementById("confirmAdminPin").value;
  const status = document.getElementById("changePinStatus");
  if (!/^\d{4}$/.test(currentPin) || !/^\d{4}$/.test(newPin)) {
    status.className = "meeting-edit-status error";
    status.textContent = "Both PINs must contain exactly 4 digits.";
    return;
  }
  if (newPin !== confirmPin) {
    status.className = "meeting-edit-status error";
    status.textContent = "The new PIN confirmation does not match.";
    return;
  }
  status.className = "meeting-edit-status";
  status.textContent = "Changing the administrator PIN…";
  try {
    await apiRequest({ action: "changePin", currentPin, newPin });
    status.className = "meeting-edit-status success";
    status.textContent = "Administrator PIN changed. You can also use the master PIN to reset it if it is lost.";
    event.currentTarget.reset();
  } catch (error) {
    status.className = "meeting-edit-status error";
    status.textContent = `Unable to change PIN: ${error.message}`;
  }
}

function renderMeetingReadiness(model, meeting) {
  const requirements = [];
  ["Theme", "Theme Question", "Word of the day", "Quote of the day"].forEach(label => {
    requirements.push({ label, complete: Boolean(clean(model.rowsByLabel.get(label)?.row[meeting.col])) });
  });
  ROLE_LABELS.filter(role => role !== "Speaker" && role !== "Evaluator").forEach(label => {
    requirements.push({ label, complete: Boolean(normalizeName(model.rowsByLabel.get(label)?.row[meeting.col])) });
  });
  for (let number = 1; number <= 3; number += 1) {
    const speaker = normalizeName(model.rowsByLabel.get(`Speaker ${number}`)?.row[meeting.col]);
    if (number > 1 && !speaker) continue;
    requirements.push(
      { label: `Speaker ${number}`, complete: Boolean(speaker) },
      { label: `Title ${number}`, complete: Boolean(clean(model.rowsByLabel.get(`Title ${number}`)?.row[meeting.col])) },
      { label: `Evaluator ${number}`, complete: Boolean(normalizeName(model.rowsByLabel.get(`Evaluator ${number}`)?.row[meeting.col])) },
    );
  }
  const completed = requirements.filter(item => item.complete).length;
  const total = requirements.length;
  const percentage = Math.round(completed / total * 100);
  const missing = requirements.filter(item => !item.complete).map(item => item.label);
  const tone = percentage === 100 ? "ready" : percentage >= 70 ? "almost-ready" : "needs-attention";
  const status = percentage === 100 ? "Ready" : percentage >= 70 ? "Almost ready" : "Needs attention";
  const container = document.getElementById("meetingReadiness");
  container.className = `meeting-readiness ${tone}`;
  setText("readinessStatus", status);
  setText("readinessScore", `${percentage}% (${completed}/${total})`);
  const missingElement = document.getElementById("readinessMissing");
  if (missing.length) {
    const visibleMissing = missing.slice(0, 3);
    const remaining = missing.length - visibleMissing.length;
    missingElement.textContent = `Missing ${missing.length}: ${visibleMissing.join(", ")}${remaining ? ` +${remaining} more` : ""}`;
    missingElement.title = `Missing: ${missing.join(", ")}`;
    container.setAttribute("aria-disabled", "false");
    container.tabIndex = 0;
    document.getElementById("missingDialogSummary").textContent = `${missing.length} of ${total} required fields still need information.`;
    document.getElementById("missingDialogList").innerHTML = missing.map(item => `<li>${escapeHtml(item)}</li>`).join("");
  } else {
    missingElement.textContent = "All required fields are complete.";
    missingElement.removeAttribute("title");
    container.setAttribute("aria-disabled", "true");
    container.tabIndex = -1;
    document.getElementById("missingDialogSummary").textContent = "All required fields are complete.";
    document.getElementById("missingDialogList").innerHTML = "";
  }
  const track = container.querySelector(".readiness-track");
  track.setAttribute("aria-valuenow", String(percentage));
  document.getElementById("readinessBar").style.width = `${percentage}%`;
}

function countBy(items, keyFn) {
  return items.reduce((map, item) => map.set(keyFn(item), (map.get(keyFn(item)) || 0) + 1), new Map());
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}
function setText(id, value) { document.getElementById(id).textContent = value; }
function tooltipText(items) {
  return items.slice(0, 9).map(item => `${formatDate(item.date)} · ${item.member || item.speaker}${item.meetingNo ? ` · ${item.meetingNo}` : ""}`).join("\n") + (items.length > 9 ? `\n외 ${items.length - 9}건` : "");
}
function addTooltip(element, content, variant = "") {
  element.dataset.tooltip = content;
  element.dataset.tooltipVariant = variant;
  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    element.addEventListener("mouseenter", showTooltip);
    element.addEventListener("mousemove", moveTooltip);
    element.addEventListener("mouseleave", hideTooltip);
    element.addEventListener("focus", showTooltip);
    element.addEventListener("blur", hideTooltip);
  }
  element.tabIndex = 0;
}
function showTooltip(event) {
  const tooltip = document.getElementById("tooltip");
  tooltip.textContent = event.currentTarget.dataset.tooltip;
  tooltip.classList.toggle("detail", event.currentTarget.dataset.tooltipVariant === "detail");
  tooltip.classList.add("visible"); tooltip.setAttribute("aria-hidden", "false"); moveTooltip(event);
}
function moveTooltip(event) {
  const tooltip = document.getElementById("tooltip");
  const x = Math.min((event.clientX || 20) + 14, window.innerWidth - tooltip.offsetWidth - 12);
  const y = Math.min((event.clientY || 20) + 14, window.innerHeight - tooltip.offsetHeight - 12);
  tooltip.style.left = `${Math.max(8, x)}px`; tooltip.style.top = `${Math.max(8, y)}px`;
}
function hideTooltip() {
  const tooltip = document.getElementById("tooltip");
  tooltip.classList.remove("visible");
  tooltip.setAttribute("aria-hidden", "true");
  tooltip.style.left = "";
  tooltip.style.top = "";
}

function renderFilters(model) {
  const memberSelect = document.getElementById("memberFilter");
  const roleSelect = document.getElementById("roleFilter");
  const members = [...model.members].sort((a,b) => a.name.localeCompare(b.name));
  memberSelect.innerHTML = `<option value="all">All members</option>${members.map(m => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)}</option>`).join("")}`;
  roleSelect.innerHTML = `<option value="all">All roles</option>${ROLE_LABELS.map(role => `<option value="${role}">${role}</option>`).join("")}`;
  memberSelect.value = state.member; roleSelect.value = state.role;
}

function filteredAssignments(model) {
  return model.assignments.filter(item => (state.member === "all" || item.member === state.member) && (state.role === "all" || item.role === state.role));
}
function renderRoles(model) {
  const assignments = filteredAssignments(model);
  const roleCounts = countBy(assignments, item => item.role);
  const chart = document.getElementById("roleChart");
  const roles = ROLE_LABELS.map(role => ({ role, count: roleCounts.get(role) || 0, items: assignments.filter(item => item.role === role) })).filter(x => x.count || state.role === x.role);
  const max = Math.max(1, ...roles.map(x => x.count));
  chart.innerHTML = roles.length ? roles.map(item => `
    <div class="bar-row">
      <span class="bar-label">${escapeHtml(item.role)}</span>
      <div class="bar-track" data-role="${escapeHtml(item.role)}"><div class="bar-fill" style="--width:${(item.count / max * 100).toFixed(1)}%"></div></div>
      <span class="bar-value">${item.count}</span>
    </div>`).join("") : `<div class="empty-state">선택 조건에 맞는 역할 내역이 없습니다.</div>`;
  chart.querySelectorAll(".bar-track").forEach(el => {
    const items = roles.find(x => x.role === el.dataset.role)?.items || [];
    addTooltip(el, `${el.dataset.role} · ${items.length}회\n${tooltipText(items)}`);
  });
  setText("roleScopeLabel", state.member === "all" ? "All members" : state.member);

  const memberTable = document.getElementById("memberTable");
  const ranked = [...model.members].map(member => {
    const counts = countBy(member.roles, item => item.role);
    const top = [...counts.entries()].sort((a,b) => b[1] - a[1])[0];
    return { ...member, total: member.roles.length, top: top ? `${top[0]} · ${top[1]}` : "—" };
  }).sort((a,b) => (b.total + b.speeches.length) - (a.total + a.speeches.length));
  memberTable.innerHTML = ranked.map(member => `<tr data-member="${escapeHtml(member.name)}" class="${state.member === member.name ? "active" : ""}"><td><strong>${escapeHtml(member.name)}</strong></td><td>${member.total}</td><td>${member.speeches.length}</td><td>${escapeHtml(member.top)}</td></tr>`).join("");
  memberTable.querySelectorAll("tr").forEach(row => row.addEventListener("click", () => {
    state.member = row.dataset.member; document.getElementById("memberFilter").value = state.member; renderRoles(model); renderHistory(model);
  }));
  renderHistory(model);
}

function renderHistory(model) {
  const items = filteredAssignments(model).sort((a,b) => b.date - a.date);
  setText("historyCount", `${items.length} assignments`);
  const container = document.getElementById("activityHistory");
  container.innerHTML = items.length ? items.map(item => `<article class="activity-card"><time>${formatDate(item.date)} · ${escapeHtml(item.meetingNo)}</time><strong>${escapeHtml(item.role)}</strong><span>${escapeHtml(item.member)}</span></article>`).join("") : `<div class="empty-state">표시할 활동이 없습니다.</div>`;
  container.querySelectorAll(".activity-card").forEach((card, index) => addTooltip(card, `${items[index].member}\n${items[index].role}\n${formatDate(items[index].date)} · Meeting ${items[index].meetingNo}`));
}

function renderSpeeches(model) {
  const ranking = [...model.members].filter(m => m.speeches.length).sort((a,b) => b.speeches.length - a.speeches.length || a.name.localeCompare(b.name));
  document.getElementById("speechRanking").innerHTML = ranking.slice(0, 12).map((member, index) => `<div class="speaker-rank" data-name="${escapeHtml(member.name)}"><span class="rank">${String(index + 1).padStart(2,"0")}</span><strong>${escapeHtml(member.name)}</strong><b>${member.speeches.length}</b></div>`).join("");
  document.querySelectorAll(".speaker-rank").forEach((el, index) => addTooltip(el, `${ranking[index].name} · ${ranking[index].speeches.length} speeches\n${ranking[index].speeches.map(s => `${formatDate(s.date)} · ${s.title}`).join("\n")}`));
  const speeches = [...model.speeches].sort((a,b) => b.date - a.date);
  document.getElementById("speechTimeline").innerHTML = speeches.map(speech => `<article class="speech-card"><time>${formatDate(speech.date)} · ${escapeHtml(speech.meetingNo)}</time><h4>${escapeHtml(speech.title)}</h4><p>${escapeHtml(speech.speaker)}</p></article>`).join("");
  document.querySelectorAll(".speech-card").forEach((card, index) => {
    const speech = speeches[index];
    addTooltip(card, `${speech.speaker} · ${speech.title}\nProject: ${speech.project || "—"}\nTime: ${speech.time || "—"}\nEvaluator: ${speech.evaluator || "—"}`);
  });
}

function renderThisWeek(model) {
  const meetingsByView = {
    past: model.pastMeeting,
    coming: model.comingMeeting,
    next: model.followingMeeting,
  };
  const meeting = meetingsByView[state.meetingView];
  document.querySelectorAll("[data-edit-section]").forEach(button => {
    button.disabled = state.meetingView === "past" || !meeting;
    button.title = state.meetingView === "past" ? "Past meetings are read-only." : "";
  });
  setText("meetingEyebrow", "YTTM MEETING SCHEDULE");
  if (!meeting) {
    setText("meetingTitle", "No Scheduled Meeting");
    const readiness = document.getElementById("meetingReadiness");
    readiness.className = "meeting-readiness needs-attention";
    readiness.setAttribute("aria-disabled", "true");
    readiness.tabIndex = -1;
    setText("readinessStatus", "Needs attention");
    setText("readinessScore", "0% (0/23)");
    setText("readinessMissing", "No meeting is scheduled.");
    document.querySelector(".readiness-track").setAttribute("aria-valuenow", "0");
    document.getElementById("readinessBar").style.width = "0%";
    setText("meetingNumber", "—");
    document.getElementById("specialEvent").classList.add("hidden");
    document.getElementById("meetingContext").innerHTML = `<div class="empty-state">No meeting details are available.</div>`;
    document.getElementById("weekAssignments").innerHTML = `<div class="empty-state">No role assignments are available.</div>`;
    document.getElementById("agendaTimeline").innerHTML = `<div class="empty-state">No agenda is available.</div>`;
    document.getElementById("weekSpeeches").innerHTML = `<div class="empty-state">No prepared speeches are available.</div>`;
    return;
  }
  setText("meetingTitle", `${formatMeetingDate(meeting.date)} Meeting`);
  renderMeetingReadiness(model, meeting);
  setText("meetingNumber", meeting.meetingNo || "—");
  const special = document.getElementById("specialEvent");
  special.textContent = meeting.special ? `Special event · ${meeting.special}` : "";
  special.classList.toggle("hidden", !meeting.special);

  const contextFields = [
    ["Theme", clean(model.rowsByLabel.get("Theme")?.row[meeting.col])],
    ["Theme Question", clean(model.rowsByLabel.get("Theme Question")?.row[meeting.col])],
    ["Word of the day", clean(model.rowsByLabel.get("Word of the day")?.row[meeting.col])],
    ["Quote of the day", clean(model.rowsByLabel.get("Quote of the day")?.row[meeting.col])],
  ];
  const meetingContext = document.getElementById("meetingContext");
  meetingContext.innerHTML = contextFields.map(([label, value], index) => `
    <button type="button" class="meeting-context-item ${value ? "" : "pending"}" data-theme-index="${index}" aria-haspopup="dialog">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "Pending")}</strong>
    </button>`).join("");
  meetingContext.querySelectorAll("[data-theme-index]").forEach(button => {
    const [label, value] = contextFields[Number(button.dataset.themeIndex)];
    button.addEventListener("click", () => showThemeDetails(label, value));
    addMobileLongPress(button, () => openMeetingEditor("theme", label));
  });

  const assignments = [];
  model.rowsByLabel.forEach(({ row }, label) => {
    if (!isRoleRow(label)) return;
    const role = canonicalRole(label);
    if (role === "Speaker" || role === "Evaluator") return;
    const member = normalizeName(row[meeting.col]);
    assignments.push({ role, member: member || "Pending", pending: !member });
  });
  const assignmentContainer = document.getElementById("weekAssignments");
  assignmentContainer.innerHTML = assignments.length ? assignments.map((item, index) => `<button type="button" class="assignment ${item.pending ? "pending" : ""}" data-assignment-index="${index}" aria-haspopup="dialog"><span>${escapeHtml(item.role)}</span><strong>${escapeHtml(item.member)}</strong></button>`).join("") : `<div class="empty-state">No role assignments are available yet.</div>`;
  assignmentContainer.querySelectorAll("[data-assignment-index]").forEach(button => {
    const assignment = assignments[Number(button.dataset.assignmentIndex)];
    button.addEventListener("click", () => showRoleDetails(assignment));
    addMobileLongPress(button, () => openMeetingEditor("roles", assignment.role));
  });
  renderCompactAgenda(model, meeting);

  const weekSpeeches = [];
  for (let number = 1; number <= 4; number += 1) {
    const speaker = normalizeName(model.rowsByLabel.get(`Speaker ${number}`)?.row[meeting.col]);
    if (number > 1 && !speaker) continue;
    const title = clean(model.rowsByLabel.get(`Title ${number}`)?.row[meeting.col]);
    const evaluator = normalizeName(model.rowsByLabel.get(`Evaluator ${number}`)?.row[meeting.col]);
    weekSpeeches.push({
      slot: number,
      speaker: speaker || `Speaker ${number} · Pending`,
      title: title || "Title Pending",
      project: clean(model.rowsByLabel.get(`Project ${number}`)?.row[meeting.col]),
      time: clean(model.rowsByLabel.get(`Time ${number}`)?.row[meeting.col]),
      evaluator: evaluator || "Pending",
      pending: !speaker || !title || !evaluator,
    });
  }
  const weekContainer = document.getElementById("weekSpeeches");
  weekContainer.innerHTML = weekSpeeches.map(s => `<article class="week-speech ${s.pending ? "pending" : ""}" role="button" tabindex="0" aria-haspopup="dialog" aria-label="Open speech details for ${escapeHtml(s.speaker)}"><span class="speaker">${escapeHtml(s.speaker)}</span><h4>${escapeHtml(s.title)}</h4><p>${escapeHtml(`Evaluator · ${s.evaluator}`)}</p></article>`).join("");
  weekContainer.querySelectorAll(".week-speech").forEach((card, index) => {
    const speech = weekSpeeches[index];
    addTooltip(card, `${speech.speaker} · ${speech.title}\nProject: ${speech.project || "—"}\nTime: ${speech.time || "—"}\nEvaluator: ${speech.evaluator || "—"}`);
    const openDetails = () => showSpeechDetails(speech);
    card.addEventListener("click", openDetails);
    addMobileLongPress(card, () => openMeetingEditor("speeches", "", speech.slot));
    card.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDetails();
      }
    });
  });
}

function showSpeechDetails(speech) {
  hideTooltip();
  setText("speechDialogTitle", speech.title || "Title Pending");
  document.getElementById("speechDialogDetails").innerHTML = [
    ["Speaker", speech.speaker],
    ["Project", speech.project || "Pending"],
    ["Time", speech.time || "Pending"],
    ["Evaluator", speech.evaluator || "Pending"],
  ].map(([label, value]) => `<div class="speech-detail-item ${value === "Pending" || String(value).includes("Pending") ? "pending" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  const editButton = document.getElementById("speechDialogEditButton");
  const actions = document.getElementById("speechDialogActions");
  editButton.dataset.speechSlot = speech.slot;
  const editable = state.meetingView !== "past" && Boolean(activeMeeting());
  actions.classList.toggle("hidden", !editable);
  editButton.disabled = !editable;
  document.getElementById("speechDetailsDialog").showModal();
}

function render(model, meta) {
  setText("asOfDate", formatDate(model.today, { year: "numeric" }));
  setText("meetingCount", model.completedColumns.length);
  setText("roleCount", model.assignments.length);
  setText("speechCount", model.speeches.length);
  setText("memberCount", model.members.length);
  document.getElementById("sheetLink").href = meta.source;
  setText("lastSync", `Last synced ${new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date(meta.fetchedAt))} · Google Sheets`);
  renderFilters(model); renderRoles(model); renderSpeeches(model); renderThisWeek(model);
}

async function loadDashboard(force = false) {
  const button = document.getElementById("refreshButton");
  const banner = document.getElementById("statusBanner");
  button.classList.add("loading"); button.disabled = true;
  banner.className = "status-banner"; banner.textContent = "Loading the latest data from Google Sheets.";
  try {
    const isGitHubPages = location.hostname.endsWith(".github.io");
    let payload;
    if (isGitHubPages) {
      payload = await fetchPublicSheets();
    } else {
      try {
        const endpoint = force ? `/api/sheets?refresh=${Date.now()}` : "/api/sheets";
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) throw new Error((await response.json()).detail || `HTTP ${response.status}`);
        payload = await response.json();
      } catch (serverError) {
        console.warn("Local sheet proxy unavailable; using the public read-only sheets endpoint.", serverError);
        payload = await fetchPublicSheets();
      }
    }
    const rolesRows = parseCsv(payload.rolesCsv);
    const agendaRows = parseCsv(payload.agendaCsv);
    if (rolesRows.length < 10) throw new Error("26_Roles is empty.");
    captureSheetBaseValues(rolesRows);
    try {
      state.sharedDrafts = await fetchSharedDrafts();
    } catch (draftError) {
      console.warn("Shared drafts are temporarily unavailable.", draftError);
      state.sharedDrafts = { revision: 0, updatedAt: "", meetings: {}, locks: {}, fieldVersions: {} };
    }
    applySharedDraftsToRows(rolesRows, state.sharedDrafts);
    state.model = buildModel(rolesRows, agendaRows);
    render(state.model, payload);
    renderDraftSyncState();
    banner.className = "status-banner ready";
    const meeting = state.model.comingMeeting;
    banner.textContent = meeting
      ? `Updated ${formatDate(meeting.date, { year: "numeric" })} ${meeting.meetingNo || ""} from Google Sheets.`
      : "Updated the latest data from Google Sheets.";
  } catch (error) {
    console.error(error);
    banner.className = "status-banner error";
    banner.textContent = `Unable to load data: ${error.message}`;
  } finally {
    button.classList.remove("loading"); button.disabled = false;
  }
}

document.getElementById("memberFilter").addEventListener("change", event => { state.member = event.target.value; renderRoles(state.model); });
document.getElementById("roleFilter").addEventListener("change", event => { state.role = event.target.value; renderRoles(state.model); });
document.getElementById("refreshButton").addEventListener("click", () => loadDashboard(true));

let sharedDraftPollBusy = false;
async function pollSharedDrafts() {
  if (sharedDraftPollBusy || document.hidden || !WRITE_ENDPOINT) return;
  sharedDraftPollBusy = true;
  try {
    const latest = await fetchSharedDrafts();
    if (Number(latest.revision || 0) === Number(state.sharedDrafts.revision || 0)) return;
    const editDialog = document.getElementById("meetingEditDialog");
    if (editDialog.open) {
      const status = document.getElementById("meetingEditStatus");
      status.className = "meeting-edit-status warning";
      status.textContent = "Another person changed the shared schedule. Save will verify this field before accepting your entry.";
      return;
    }
    await loadDashboard(true);
    const banner = document.getElementById("statusBanner");
    banner.className = "status-banner ready";
    banner.textContent = "Another person's shared change was loaded automatically.";
  } catch (error) {
    console.warn("Unable to check for shared changes.", error);
  } finally {
    sharedDraftPollBusy = false;
  }
}
setInterval(pollSharedDrafts, 10000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) pollSharedDrafts(); });
const adminApplyDialog = document.getElementById("adminApplyDialog");
const changePinDialog = document.getElementById("changePinDialog");
function openPinSettings() {
  document.getElementById("changePinForm").reset();
  setText("changePinStatus", "Enter the current PIN, or use the master PIN if the administrator PIN was lost. The new PIN cannot match the master PIN.");
  changePinDialog.showModal();
}
document.getElementById("applySheetsButton").addEventListener("click", openAdminApplyDialog);
document.getElementById("adminSettingsButton").addEventListener("click", openPinSettings);
document.getElementById("closeAdminApplyDialog").addEventListener("click", () => adminApplyDialog.close());
document.getElementById("adminApplyForm").addEventListener("submit", applySharedDrafts);
document.getElementById("openChangePinDialog").addEventListener("click", openPinSettings);
document.getElementById("closeChangePinDialog").addEventListener("click", () => changePinDialog.close());
document.getElementById("changePinForm").addEventListener("submit", changeAdministratorPin);
adminApplyDialog.addEventListener("click", event => { if (event.target === adminApplyDialog) adminApplyDialog.close(); });
changePinDialog.addEventListener("click", event => { if (event.target === changePinDialog) changePinDialog.close(); });
const missingDialog = document.getElementById("missingDetailsDialog");
const readinessCard = document.getElementById("meetingReadiness");
function openMissingDialog() {
  if (readinessCard.getAttribute("aria-disabled") !== "true") missingDialog.showModal();
}
readinessCard.addEventListener("click", openMissingDialog);
readinessCard.addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openMissingDialog();
  }
});
document.getElementById("closeMissingDialog").addEventListener("click", event => {
  event.stopPropagation();
  missingDialog.close();
});
missingDialog.addEventListener("click", event => {
  if (missingDialog.open) missingDialog.close();
});
const speechDialog = document.getElementById("speechDetailsDialog");
document.getElementById("closeSpeechDialog").addEventListener("click", event => {
  event.stopPropagation();
  speechDialog.close();
});
speechDialog.addEventListener("click", event => {
  if (speechDialog.open) speechDialog.close();
});
speechDialog.addEventListener("close", hideTooltip);
document.getElementById("speechDialogEditButton").addEventListener("click", event => {
  event.stopPropagation();
  const slot = Number(event.currentTarget.dataset.speechSlot);
  speechDialog.close();
  openMeetingEditor("speeches", "", slot);
  requestAnimationFrame(() => document.querySelector("#meetingEditFields [data-edit-field]")?.focus());
});
const agendaDialog = document.getElementById("agendaDetailsDialog");
document.getElementById("closeAgendaDialog").addEventListener("click", event => {
  event.stopPropagation();
  agendaDialog.close();
});
agendaDialog.addEventListener("click", event => {
  if (event.target === agendaDialog && agendaDialog.open) agendaDialog.close();
});
document.getElementById("agendaDialogEditButton").addEventListener("click", event => {
  event.stopPropagation();
  const button = event.currentTarget;
  const section = button.dataset.editSection;
  const field = button.dataset.editField;
  agendaDialog.close();
  openMeetingEditor(section, field);
  requestAnimationFrame(() => document.querySelector("#meetingEditFields [data-edit-field]")?.focus());
});
const meetingEditDialog = document.getElementById("meetingEditDialog");
document.querySelectorAll("[data-edit-section]").forEach(button => button.addEventListener("click", () => openMeetingEditor(button.dataset.editSection)));
function closeMeetingEditor() {
  clearInterval(meetingLockTimer);
  meetingLockTimer = null;
  meetingEditDialog.close();
}
document.getElementById("closeMeetingEditDialog").addEventListener("click", closeMeetingEditor);
document.getElementById("cancelMeetingEdit").addEventListener("click", closeMeetingEditor);
document.getElementById("meetingEditForm").addEventListener("submit", saveMeetingEditor);
document.getElementById("meetingEditFields").addEventListener("input", updateMeetingEditorState);
document.getElementById("meetingEditFields").addEventListener("click", event => {
  const clearButton = event.target.closest("[data-clear-field]");
  if (!clearButton) return;
  const input = document.querySelector(`#meetingEditFields [data-edit-field="${CSS.escape(clearButton.dataset.clearField)}"]`);
  if (input) { input.value = ""; input.focus(); updateMeetingEditorState(); }
});
document.querySelectorAll("[data-dashboard-tab]").forEach(button => {
  button.addEventListener("click", () => setActiveTab(button.dataset.dashboardTab));
});
let swipeStart = null;
let suppressSwipeClickUntil = 0;
let swipeAnimating = false;
const meetingPanel = document.getElementById("this-week");
const meetingViews = ["past", "coming", "next"];

function meetingSwipeTarget(deltaX) {
  const currentIndex = meetingViews.indexOf(state.meetingView);
  const targetIndex = deltaX < 0 ? currentIndex + 1 : currentIndex - 1;
  return meetingViews[targetIndex] || null;
}

function resetMeetingSwipe(animated = true) {
  meetingPanel.style.transition = animated ? "transform 180ms ease-out, opacity 180ms ease-out" : "none";
  meetingPanel.style.transform = "translate3d(0, 0, 0)";
  meetingPanel.style.opacity = "1";
}

function completeMeetingSwipe(target, deltaX) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    setActiveTab(target, true, false);
    resetMeetingSwipe(false);
    return;
  }
  swipeAnimating = true;
  const direction = Math.sign(deltaX);
  meetingPanel.style.transition = "transform 190ms ease-in, opacity 190ms ease-in";
  meetingPanel.style.transform = `translate3d(${direction * window.innerWidth}px, 0, 0)`;
  meetingPanel.style.opacity = "0.35";
  window.setTimeout(() => {
    setActiveTab(target, true, false);
    meetingPanel.style.transition = "none";
    meetingPanel.style.transform = `translate3d(${-direction * window.innerWidth}px, 0, 0)`;
    meetingPanel.style.opacity = "0.35";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      meetingPanel.style.transition = "transform 230ms cubic-bezier(.22,.72,.25,1), opacity 230ms ease-out";
      meetingPanel.style.transform = "translate3d(0, 0, 0)";
      meetingPanel.style.opacity = "1";
      window.setTimeout(() => {
        meetingPanel.style.transition = "";
        meetingPanel.style.transform = "";
        meetingPanel.style.opacity = "";
        swipeAnimating = false;
      }, 240);
    }));
  }, 195);
}

document.addEventListener("touchstart", event => {
  if (swipeAnimating || event.touches.length !== 1) return;
  if (document.querySelector("dialog[open]") || event.target.closest(".topbar, .dashboard-tabs, dialog")) return;
  const touch = event.touches[0];
  swipeStart = { x: touch.clientX, y: touch.clientY };
  resetMeetingSwipe(false);
}, { passive: true });
document.addEventListener("touchmove", event => {
  if (!swipeStart || event.touches.length !== 1) return;
  const touch = event.touches[0];
  const deltaX = touch.clientX - swipeStart.x;
  const deltaY = touch.clientY - swipeStart.y;
  if (Math.abs(deltaX) <= 8 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
  event.preventDefault();
  const atBoundary = !meetingSwipeTarget(deltaX);
  const visualX = atBoundary ? deltaX * 0.18 : deltaX;
  meetingPanel.style.transition = "none";
  meetingPanel.style.transform = `translate3d(${visualX}px, 0, 0)`;
  meetingPanel.style.opacity = String(Math.max(0.72, 1 - Math.abs(visualX) / window.innerWidth * 0.28));
}, { passive: false });
document.addEventListener("touchend", event => {
  if (!swipeStart || event.changedTouches.length !== 1) return;
  const touch = event.changedTouches[0];
  const deltaX = touch.clientX - swipeStart.x;
  const deltaY = touch.clientY - swipeStart.y;
  swipeStart = null;
  const threshold = Math.min(56, window.innerWidth * 0.14);
  if (Math.abs(deltaX) < threshold || Math.abs(deltaX) <= Math.abs(deltaY) * 1.15) {
    resetMeetingSwipe(true);
    return;
  }
  suppressSwipeClickUntil = Date.now() + 450;
  const target = meetingSwipeTarget(deltaX);
  if (target) completeMeetingSwipe(target, deltaX);
  else resetMeetingSwipe(true);
}, { passive: true });
document.addEventListener("touchcancel", () => { swipeStart = null; resetMeetingSwipe(true); }, { passive: true });
document.addEventListener("click", event => {
  if (Date.now() < suppressSwipeClickUntil || Date.now() < suppressLongPressClickUntil) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);
const initialTab = ({ "#past-meeting": "past", "#coming-up": "coming", "#next-meeting": "next" })[location.hash] || "coming";
setActiveTab(initialTab, false);
loadDashboard(false);
