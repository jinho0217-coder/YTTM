const state = { model: null, member: "all", role: "all", meetingView: "coming" };
const SHEET_ID = "1arhgy3QSwHxyM9gBy6nXdw76N-94R53kf0ogV4Nq2lA";
const SHEET_SOURCE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=1852116681`;

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
  const validTabs = new Set(["coming", "next"]);
  const activeTab = validTabs.has(tabName) ? tabName : "coming";
  state.meetingView = activeTab;
  document.querySelectorAll("[data-dashboard-tab]").forEach(button => {
    button.setAttribute("aria-selected", String(button.dataset.dashboardTab === activeTab));
  });
  document.querySelectorAll("[data-tab-panel]").forEach(panel => {
    panel.hidden = panel.dataset.tabPanel !== "week";
  });
  if (state.model) renderThisWeek(state.model);
  if (updateHash) history.replaceState(null, "", activeTab === "coming" ? "#coming-up" : "#next-meeting");
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
function todayKst() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return new Date(`${map.year}-${map.month}-${map.day}T00:00:00+09:00`);
}
function formatDate(date, options = {}) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "short", ...options }).format(date);
}
function formatMeetingDate(date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" }).format(date);
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
  const columns = [];
  for (let col = 1; col < dates.length; col += 1) {
    const date = parseDate(dates[col]);
    if (!date) continue;
    const special = clean(rowsByLabel.get("Special Event")?.row[col]);
    const chair = clean(rowsByLabel.get("Chairperson")?.row[col]);
    const noMeeting = /no meeting/i.test(`${special} ${chair}`);
    columns.push({ col, date, meetingNo: clean(meetingNos[col]), special, noMeeting });
  }

  const completedColumns = columns.filter(c => c.date < today && !c.noMeeting).filter(c => {
    const anchors = ["Chairperson", "Toastmaster", "General Evaluator", "Speaker 1"];
    return anchors.filter(label => clean(rowsByLabel.get(label)?.row[c.col])).length >= 3;
  });
  const completedSet = new Set(completedColumns.map(c => c.col));
  const upcomingMeetings = columns.filter(c => c.date >= today && !c.noMeeting);
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
    today, rowsByLabel, columns, completedColumns, completedSet, comingMeeting, followingMeeting,
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

function weeklyAgenda(model, meeting) {
  const memberFor = label => normalizeName(model.rowsByLabel.get(label)?.row[meeting.col]);
  const speakerNames = [1, 2, 3, 4]
    .map(number => normalizeName(model.rowsByLabel.get(`Speaker ${number}`)?.row[meeting.col]))
    .filter(Boolean);
  const speakerSummary = speakerNames.length
    ? `${speakerNames.length} speaker${speakerNames.length === 1 ? "" : "s"} (${speakerNames.join(", ")})`
    : "Speakers pending";
  const details = new Map([
    ["Introduction", ["Chairperson", memberFor("Chairperson")]],
    ["Toastmaster's Session", ["Toastmaster", memberFor("Toastmaster")]],
    ["Prepared Speech Session", [speakerSummary, ""]],
    ["Q & A Session to speakers", [speakerNames.length ? `Questions to ${speakerNames.join(", ")}` : "Questions to speakers", ""]],
    ["Q & A Session", [speakerNames.length ? `Questions to ${speakerNames.join(", ")}` : "Questions to speakers", ""]],
    ["Table Topics", ["Table Topic Master", memberFor("Table Topic Master")]],
    ["Evaluation Session", ["General Evaluator", memberFor("General Evaluator")]],
    ["Announcement Session", ["Toastmaster", memberFor("Toastmaster")]],
    ["Closing", ["Chairperson", memberFor("Chairperson")]],
  ]);

  return model.agenda.map(([time, title, fallback]) => {
    const detail = details.get(title);
    if (!detail) return [time, title, fallback];
    return [time, title, detail.filter(Boolean).join(" · ")];
  });
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
function addTooltip(element, content) {
  element.dataset.tooltip = content;
  element.addEventListener("mouseenter", showTooltip);
  element.addEventListener("mousemove", moveTooltip);
  element.addEventListener("mouseleave", hideTooltip);
  element.addEventListener("focus", showTooltip);
  element.addEventListener("blur", hideTooltip);
  element.tabIndex = 0;
}
function showTooltip(event) {
  const tooltip = document.getElementById("tooltip");
  tooltip.textContent = event.currentTarget.dataset.tooltip;
  tooltip.classList.add("visible"); tooltip.setAttribute("aria-hidden", "false"); moveTooltip(event);
}
function moveTooltip(event) {
  const tooltip = document.getElementById("tooltip");
  const x = Math.min((event.clientX || 20) + 14, window.innerWidth - tooltip.offsetWidth - 12);
  const y = Math.min((event.clientY || 20) + 14, window.innerHeight - tooltip.offsetHeight - 12);
  tooltip.style.left = `${Math.max(8, x)}px`; tooltip.style.top = `${Math.max(8, y)}px`;
}
function hideTooltip() { document.getElementById("tooltip").classList.remove("visible"); }

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
  const isComing = state.meetingView === "coming";
  const meeting = isComing ? model.comingMeeting : model.followingMeeting;
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
  document.getElementById("meetingContext").innerHTML = contextFields.map(([label, value]) => `
    <div class="meeting-context-item ${value ? "" : "pending"}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "Pending")}</strong>
    </div>`).join("");

  const assignments = [];
  model.rowsByLabel.forEach(({ row }, label) => {
    if (!isRoleRow(label)) return;
    const role = canonicalRole(label);
    if (role === "Speaker" || role === "Evaluator") return;
    const member = normalizeName(row[meeting.col]);
    assignments.push({ role, member: member || "Pending", pending: !member });
  });
  document.getElementById("weekAssignments").innerHTML = assignments.length ? assignments.map(item => `<div class="assignment ${item.pending ? "pending" : ""}"><span>${escapeHtml(item.role)}</span><strong>${escapeHtml(item.member)}</strong></div>`).join("") : `<div class="empty-state">No role assignments are available yet.</div>`;
  document.getElementById("agendaTimeline").innerHTML = weeklyAgenda(model, meeting).map(item => `<div class="agenda-item"><span class="agenda-time">${escapeHtml(item[0])}</span><span class="agenda-line"></span><div class="agenda-copy"><strong>${escapeHtml(item[1])}</strong><small>${escapeHtml(item[2])}</small></div></div>`).join("");

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
    card.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDetails();
      }
    });
  });
}

function showSpeechDetails(speech) {
  setText("speechDialogTitle", speech.title || "Title Pending");
  document.getElementById("speechDialogDetails").innerHTML = [
    ["Speaker", speech.speaker],
    ["Project", speech.project || "Pending"],
    ["Time", speech.time || "Pending"],
    ["Evaluator", speech.evaluator || "Pending"],
  ].map(([label, value]) => `<div class="speech-detail-item ${value === "Pending" || String(value).includes("Pending") ? "pending" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
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
      const endpoint = force ? `/api/sheets?refresh=${Date.now()}` : "/api/sheets";
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error((await response.json()).detail || `HTTP ${response.status}`);
      payload = await response.json();
    }
    const rolesRows = parseCsv(payload.rolesCsv);
    const agendaRows = parseCsv(payload.agendaCsv);
    if (rolesRows.length < 10) throw new Error("26_Roles is empty.");
    state.model = buildModel(rolesRows, agendaRows);
    render(state.model, payload);
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
document.getElementById("closeMissingDialog").addEventListener("click", () => missingDialog.close());
missingDialog.addEventListener("click", event => {
  if (event.target === missingDialog) missingDialog.close();
});
const speechDialog = document.getElementById("speechDetailsDialog");
document.getElementById("closeSpeechDialog").addEventListener("click", () => speechDialog.close());
speechDialog.addEventListener("click", event => {
  if (event.target === speechDialog) speechDialog.close();
});
document.querySelectorAll("[data-dashboard-tab]").forEach(button => {
  button.addEventListener("click", () => setActiveTab(button.dataset.dashboardTab));
});
const meetingPanel = document.getElementById("this-week");
let swipeStart = null;
meetingPanel.addEventListener("touchstart", event => {
  if (!window.matchMedia("(max-width: 620px)").matches || event.touches.length !== 1) return;
  if (event.target.closest("button, a, input, select, textarea, dialog, .meeting-readiness, .week-speech")) return;
  const touch = event.touches[0];
  swipeStart = { x: touch.clientX, y: touch.clientY };
}, { passive: true });
meetingPanel.addEventListener("touchend", event => {
  if (!swipeStart || event.changedTouches.length !== 1) return;
  const touch = event.changedTouches[0];
  const deltaX = touch.clientX - swipeStart.x;
  const deltaY = touch.clientY - swipeStart.y;
  swipeStart = null;
  const threshold = Math.min(72, window.innerWidth * 0.18);
  if (Math.abs(deltaX) < threshold || Math.abs(deltaX) <= Math.abs(deltaY) * 1.35) return;
  if (deltaX < 0 && state.meetingView === "coming") setActiveTab("next", true, false);
  if (deltaX > 0 && state.meetingView === "next") setActiveTab("coming", true, false);
}, { passive: true });
meetingPanel.addEventListener("touchcancel", () => { swipeStart = null; }, { passive: true });
const initialTab = ({ "#coming-up": "coming", "#next-meeting": "next" })[location.hash] || "coming";
setActiveTab(initialTab, false);
loadDashboard(false);
