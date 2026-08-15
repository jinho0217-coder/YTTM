const state = { model: null, member: "all", role: "all" };

function setActiveTab(tabName, updateHash = true) {
  const validTabs = new Set(["week", "overview", "roles", "speeches"]);
  const activeTab = validTabs.has(tabName) ? tabName : "week";
  document.querySelectorAll("[data-dashboard-tab]").forEach(button => {
    button.setAttribute("aria-selected", String(button.dataset.dashboardTab === activeTab));
  });
  document.querySelectorAll("[data-tab-panel]").forEach(panel => {
    panel.hidden = panel.dataset.tabPanel !== activeTab;
  });
  if (updateHash) history.replaceState(null, "", activeTab === "week" ? "#this-week" : `#${activeTab}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
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
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "short", ...options }).format(date);
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
  const nextMeeting = columns.find(c => c.date >= today && !c.noMeeting) || columns.at(-1);
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
    today, rowsByLabel, columns, completedColumns, completedSet, nextMeeting,
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
  const speakerCount = [1, 2, 3, 4]
    .filter(number => normalizeName(model.rowsByLabel.get(`Speaker ${number}`)?.row[meeting.col])).length;
  const details = new Map([
    ["Introduction", ["Chairperson", memberFor("Chairperson")]],
    ["Toastmaster's Session", ["Toastmaster", memberFor("Toastmaster")]],
    ["Prepared Speech Session", [speakerCount ? `${speakerCount} speakers` : "Speakers", ""]],
    ["Q & A Session to speakers", ["Questions to speakers", ""]],
    ["Q & A Session", ["Questions to speakers", ""]],
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
  const meeting = model.nextMeeting;
  if (!meeting) return;
  setText("weekSubtitle", `${formatDate(meeting.date, { year: "numeric" })} · 가장 가까운 예정 모임`);
  setText("meetingNumber", meeting.meetingNo || "—");
  const special = document.getElementById("specialEvent");
  special.textContent = meeting.special ? `Special event · ${meeting.special}` : "";
  special.classList.toggle("hidden", !meeting.special);

  const assignments = [];
  model.rowsByLabel.forEach(({ row }, label) => {
    if (!isRoleRow(label)) return;
    const member = normalizeName(row[meeting.col]);
    if (member) assignments.push({ role: canonicalRole(label), member });
  });
  document.getElementById("weekAssignments").innerHTML = assignments.length ? assignments.map(item => `<div class="assignment"><span>${escapeHtml(item.role)}</span><strong>${escapeHtml(item.member)}</strong></div>`).join("") : `<div class="empty-state">아직 배정된 역할이 없습니다.</div>`;
  document.getElementById("agendaTimeline").innerHTML = weeklyAgenda(model, meeting).map(item => `<div class="agenda-item"><span class="agenda-time">${escapeHtml(item[0])}</span><span class="agenda-line"></span><div class="agenda-copy"><strong>${escapeHtml(item[1])}</strong><small>${escapeHtml(item[2])}</small></div></div>`).join("");

  const weekSpeeches = [];
  for (let number = 1; number <= 4; number += 1) {
    const speaker = normalizeName(model.rowsByLabel.get(`Speaker ${number}`)?.row[meeting.col]);
    if (!speaker) continue;
    weekSpeeches.push({
      speaker,
      title: clean(model.rowsByLabel.get(`Title ${number}`)?.row[meeting.col]) || "Title pending",
      project: clean(model.rowsByLabel.get(`Project ${number}`)?.row[meeting.col]),
      time: clean(model.rowsByLabel.get(`Time ${number}`)?.row[meeting.col]),
      evaluator: normalizeName(model.rowsByLabel.get(`Evaluator ${number}`)?.row[meeting.col]),
    });
  }
  const weekContainer = document.getElementById("weekSpeeches");
  weekContainer.innerHTML = weekSpeeches.length ? weekSpeeches.map(s => `<article class="week-speech"><span class="speaker">${escapeHtml(s.speaker)}</span><h4>${escapeHtml(s.title)}</h4><p>${escapeHtml(s.evaluator ? `Evaluator · ${s.evaluator}` : "Evaluator pending")}</p></article>`).join("") : `<div class="empty-state">이번 주 스피치가 아직 등록되지 않았습니다.</div>`;
  weekContainer.querySelectorAll(".week-speech").forEach((card, index) => addTooltip(card, `${weekSpeeches[index].speaker} · ${weekSpeeches[index].title}\nProject: ${weekSpeeches[index].project || "—"}\nTime: ${weekSpeeches[index].time || "—"}\nEvaluator: ${weekSpeeches[index].evaluator || "—"}`));
}

function render(model, meta) {
  setText("asOfDate", formatDate(model.today, { year: "numeric" }));
  setText("meetingCount", model.completedColumns.length);
  setText("roleCount", model.assignments.length);
  setText("speechCount", model.speeches.length);
  setText("memberCount", model.members.length);
  document.getElementById("sheetLink").href = meta.source;
  setText("lastSync", `Last synced ${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date(meta.fetchedAt))} · Google Sheet`);
  renderFilters(model); renderRoles(model); renderSpeeches(model); renderThisWeek(model);
}

async function loadDashboard(force = false) {
  const button = document.getElementById("refreshButton");
  const banner = document.getElementById("statusBanner");
  button.classList.add("loading"); button.disabled = true;
  banner.className = "status-banner"; banner.textContent = "Google Sheet에서 최신 데이터를 불러오는 중입니다.";
  try {
    const endpoint = force ? `/api/sheets?refresh=${Date.now()}` : "/api/sheets";
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) throw new Error((await response.json()).detail || `HTTP ${response.status}`);
    const payload = await response.json();
    const rolesRows = parseCsv(payload.rolesCsv);
    const agendaRows = parseCsv(payload.agendaCsv);
    if (rolesRows.length < 10) throw new Error("26_Roles 데이터가 비어 있습니다.");
    state.model = buildModel(rolesRows, agendaRows);
    render(state.model, payload);
    banner.className = "status-banner ready";
    const meeting = state.model.nextMeeting;
    banner.textContent = meeting
      ? `${formatDate(meeting.date, { year: "numeric" })} ${meeting.meetingNo || ""} 일정을 Google Sheet에서 업데이트했습니다.`
      : "Google Sheet에서 최신 데이터를 업데이트했습니다.";
  } catch (error) {
    console.error(error);
    banner.className = "status-banner error";
    banner.textContent = `데이터를 불러오지 못했습니다: ${error.message}`;
  } finally {
    button.classList.remove("loading"); button.disabled = false;
  }
}

document.getElementById("memberFilter").addEventListener("change", event => { state.member = event.target.value; renderRoles(state.model); });
document.getElementById("roleFilter").addEventListener("change", event => { state.role = event.target.value; renderRoles(state.model); });
document.getElementById("refreshButton").addEventListener("click", () => loadDashboard(true));
document.querySelectorAll("[data-dashboard-tab]").forEach(button => {
  button.addEventListener("click", () => setActiveTab(button.dataset.dashboardTab));
});
const initialTab = ({ "#overview": "overview", "#roles": "roles", "#speeches": "speeches", "#this-week": "week" })[location.hash] || "week";
setActiveTab(initialTab, false);
loadDashboard(false);
