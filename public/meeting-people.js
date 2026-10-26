// Keep the status with the name so shared drafts and Sheets round-trip together.
const TENTATIVE_PREFIX = "◷ ";
function isTentative(value) { return /^◷\s/.test(clean(value)); }
function assignmentName(value) { return clean(value).replace(/^◷\s+/, ""); }
function isAssignmentField(label) { return ROLE_EDIT_FIELDS.includes(label) || /^(Speaker|Evaluator) [1-4]$/.test(label); }
function confirmedAssignment(value) { return Boolean(normalizeName(value)) && !isTentative(value); }
function confirmDueAssignmentRows(rows, now = new Date()) {
  const today = todayKst(now);
  const mapped = rowMap(rows);
  (rows[0] || []).forEach((value, col) => {
    const date = parseDate(value);
    if (!date || date > today || /no meeting/i.test(`${mapped.get('Special Event')?.row[col] || ''} ${mapped.get('Chairperson')?.row[col] || ''}`)) return;
    rows.forEach(row => { if (isAssignmentField(clean(row[0]))) row[col] = assignmentName(row[col]); });
  });
}
function assignmentInputValue(input) {
  const name = assignmentName(input.value);
  const toggle = document.querySelector(`[data-tentative-field="${CSS.escape(input.dataset.editField)}"]`);
  return name && toggle?.getAttribute("aria-pressed") === "true" ? TENTATIVE_PREFIX + name : name;
}
function resetTentativeAssignment(input) {
  if (!isAssignmentField(input?.dataset?.editField || "")) return;
  const toggle = document.querySelector(`[data-tentative-field="${CSS.escape(input.dataset.editField)}"]`);
  toggle?.setAttribute("aria-pressed", "false");
}
function tentativeIcon(label, value) {
  if (!isTentative(value)) return "";
  return `<button type="button" class="tentative-icon" data-assignment-status="${escapeHtml(label)}" title="예정 · 클릭하여 확정 또는 삭제" aria-label="${escapeHtml(label)} 예정 배정 변경" aria-haspopup="dialog">◷</button>`;
}
function displayAssignment(value) {
  return `${isTentative(value) ? TENTATIVE_PREFIX : ""}${normalizeName(value) || "Pending"}`;
}

function savePeopleUpdates(section, updates, expectedVersions = localFieldVersions()) {
  const meeting = activeMeeting();
  if (!meeting || meeting.noMeeting || !canEditActiveMeeting() || !WRITE_ENDPOINT) throw new Error("현재 모임은 수정할 수 없습니다.");
  const meetingDate = sheetDateValue(meeting.date);
  enqueueDraftSave({ action: "saveDraft", meetingDate, section, updates,
    baseValues: Object.fromEntries(Object.keys(updates).map(label => [label, state.sheetBaseValues[meetingDate]?.[label] || ""])),
    fieldVersions: Object.fromEntries(Object.keys(updates).map(label => [label, Number(expectedVersions[`${meetingDate}|${section}|${label}`] || 0)])),
  });
  dashboardLoadVersion += 1;
  renderSheetPayload(state.sheetPayload);
  void flushLocalSaves();
}

function readAttendees(value) {
  if (!clean(value)) return [];
  const people = JSON.parse(value);
  if (!Array.isArray(people) || people.some(p => !p || typeof p.name !== "string" || !clean(p.name) || typeof p.guest !== "boolean")) throw new Error("참석자 명단을 읽을 수 없습니다.");
  return people;
}
function meetingAttendees(model, meeting, { includeTentative = false } = {}) {
  if (!meeting || meeting.noMeeting) return [];
  const people = new Map();
  const tentativeNames = new Set();
  readAttendees(model.rowsByLabel.get("Attendees")?.row[meeting.col]).forEach(person => {
    const name = normalizeName(person.name) || clean(person.name);
    people.set(name.toLocaleLowerCase(), { name, guest: person.guest, manual: true, roles: [] });
  });
  model.rowsByLabel.forEach(({ row }, label) => {
    if (!isRoleRow(label)) return;
    const name = normalizeName(row[meeting.col]);
    if (!name) return;
    const key = name.toLocaleLowerCase();
    if (isTentative(row[meeting.col])) {
      tentativeNames.add(key);
      if (!includeTentative) return;
    }
    if (!people.has(key)) people.set(key, { name, guest: false, manual: false, roles: [] });
    people.get(key).roles.push({ label, tentative: isTentative(row[meeting.col]) });
  });
  return [...people.values()].filter(person => includeTentative || person.roles.length || !tentativeNames.has(person.name.toLocaleLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
}
function renderAttendees() {
  const meeting = activeMeeting();
  const button = document.getElementById("attendeesButton");
  button.disabled = !meeting || meeting.noMeeting;
  let people;
  try { people = state.model ? meetingAttendees(state.model, meeting) : []; }
  catch (error) {
    document.getElementById("attendeesStatus").textContent = error.message;
    document.getElementById("attendeeForm").hidden = true;
    return;
  }
  document.getElementById("attendeesCount").textContent = people.length;
  if (!document.getElementById("attendeesDialog").open) return;
  state.attendeesVersions = localFieldVersions();
  const editable = canEditActiveMeeting() && !meeting?.noMeeting && Boolean(WRITE_ENDPOINT);
  document.getElementById("attendeeForm").hidden = !editable;
  document.getElementById("attendeesTitle").textContent = `${meeting ? formatMeetingDate(meeting.date) : ""} 참석자 · ${people.length}`;
  document.getElementById("attendeesList").innerHTML = people.length ? people.map(person => `
    <li class="attendee-row"><strong>${escapeHtml(person.name)}</strong>
      <div class="attendee-roles">${person.roles.map(role => `<span>${role.tentative ? "◷ " : ""}${escapeHtml(role.label)}</span>`).join("")}</div>
      <button type="button" class="people-icon guest-toggle" data-guest-name="${escapeHtml(person.name)}" aria-label="${escapeHtml(person.name)}: ${person.guest ? "Guest. Change to Member" : "Member. Change to Guest"}" aria-pressed="${person.guest}" title="${person.guest ? "Change to Member" : "Change to Guest"}" ${editable ? "" : "disabled"}>${person.guest ? "Guest" : "Member"}</button>
      ${person.manual && !person.roles.length && editable ? `<button type="button" class="people-icon" data-remove-attendee="${escapeHtml(person.name)}" title="명단에서 삭제" aria-label="${escapeHtml(person.name)} 삭제">×</button>` : ""}
    </li>`).join("") : '<li class="empty-state">참석자 없음</li>';
}
function updateAttendee(name, action) {
  const meeting = activeMeeting();
  const people = readAttendees(editableValue(meeting, "Attendees"));
  const normalized = normalizeName(name) || clean(name);
  const index = people.findIndex(p => (normalizeName(p.name) || clean(p.name)).toLocaleLowerCase() === normalized.toLocaleLowerCase());
  if (action === "remove") { if (index >= 0) people.splice(index, 1); }
  else if (action === "guest") {
    if (index >= 0) people[index].guest = !people[index].guest;
    else people.push({ name: normalized, guest: true });
  } else {
    const assigned = meetingAttendees(state.model, meeting, { includeTentative: true }).find(person => person.name.toLocaleLowerCase() === normalized.toLocaleLowerCase());
    if (assigned?.roles.length && assigned.roles.every(role => role.tentative)) throw new Error("예정 역할을 확정하면 참석자 명단에 표시됩니다.");
    if (meetingAttendees(state.model, meeting).some(p => p.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) throw new Error("이미 명단에 있는 이름입니다.");
    people.push({ name: normalized, guest: document.getElementById("newAttendeeGuest").getAttribute("aria-pressed") === "true" });
  }
  if (people.length > 80) throw new Error("참석자는 최대 80명까지 추가할 수 있습니다.");
  savePeopleUpdates("attendees", { Attendees: people.length ? JSON.stringify(people) : "" }, state.attendeesVersions);
}
function setNewAttendeeGuest(guest) {
  const button = document.getElementById("newAttendeeGuest");
  button.setAttribute("aria-pressed", String(guest));
  button.textContent = guest ? "Guest" : "Member";
  button.title = guest ? "Change to Member" : "Change to Guest";
  button.setAttribute("aria-label", `${button.textContent}. ${button.title}`);
}
function initializeMeetingPeople() {
  setNewAttendeeGuest(false);
  const dialog = document.getElementById("attendeesDialog");
  document.getElementById("attendeesButton").addEventListener("click", () => { dialog.showModal(); renderAttendees(); });
  document.getElementById("closeAttendeesDialog").addEventListener("click", () => dialog.close());
  document.getElementById("newAttendeeGuest").addEventListener("click", event => {
    const button = event.currentTarget;
    setNewAttendeeGuest(button.getAttribute("aria-pressed") !== "true");
  });
  document.getElementById("attendeeForm").addEventListener("submit", event => {
    event.preventDefault();
    const input = document.getElementById("attendeeName");
    try {
      updateAttendee(clean(input.value), "add"); input.value = "";
      setNewAttendeeGuest(false);
      document.getElementById("attendeesStatus").textContent = ""; input.focus();
    } catch (error) { document.getElementById("attendeesStatus").textContent = error.message; }
  });
  document.getElementById("attendeesList").addEventListener("click", event => {
    const button = event.target.closest("[data-guest-name], [data-remove-attendee]");
    if (!button) return;
    try {
      updateAttendee(button.dataset.guestName || button.dataset.removeAttendee, button.dataset.guestName ? "guest" : "remove");
      document.getElementById("attendeesStatus").textContent = "";
    } catch (error) { document.getElementById("attendeesStatus").textContent = error.message; }
  });
  const statusDialog = document.getElementById("assignmentStatusDialog");
  document.getElementById("closeAssignmentStatusDialog").addEventListener("click", () => statusDialog.close());
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-assignment-status]");
    if (!button) return;
    event.stopPropagation(); hideTooltip();
    const label = button.dataset.assignmentStatus;
    state.assignmentStatusEdit = { label, value: editableValue(activeMeeting(), label), meetingDate: sheetDateValue(activeMeeting().date), versions: localFieldVersions() };
    document.getElementById("assignmentStatusTitle").textContent = assignmentName(state.assignmentStatusEdit.value);
    document.getElementById("assignmentStatusMessage").textContent = "";
    statusDialog.querySelectorAll("[data-status-action]").forEach(el => { el.disabled = !canEditActiveMeeting() || !WRITE_ENDPOINT; });
    statusDialog.showModal();
  });
  statusDialog.querySelectorAll("[data-status-action]").forEach(button => button.addEventListener("click", () => {
    const edit = state.assignmentStatusEdit;
    try {
      if (sheetDateValue(activeMeeting().date) !== edit.meetingDate) throw new Error("모임이 변경되었습니다. 다시 열어 주세요.");
      const value = button.dataset.statusAction === "confirm" ? assignmentName(edit.value) : "";
      savePeopleUpdates(/^(Speaker|Evaluator) /.test(edit.label) ? "speeches" : "roles", { [edit.label]: value }, edit.versions);
      statusDialog.close();
    } catch (error) { document.getElementById("assignmentStatusMessage").textContent = error.message; }
  }));
}
