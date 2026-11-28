// Assignment names can include a tentative marker and a guest suffix.
const TENTATIVE_PREFIX = "◷ ";
function isTentative(value) { return /^◷\s/.test(clean(value)); }
function assignmentName(value) { return clean(value).replace(/^◷\s+/, ""); }
function hasGuestSuffix(value) { return /\s*\(G\)\s*$/i.test(clean(value)); }
function assignmentPersonName(value) { return assignmentName(value).replace(/\s*\(G\)\s*$/i, "").trim(); }
function guestAssignment(value, guest) {
  const name = assignmentPersonName(value);
  return name ? `${isTentative(value) ? TENTATIVE_PREFIX : ""}${name}${guest ? " (G)" : ""}` : "";
}
function isGuestAssignment(value, model = state.model, meeting = activeMeeting()) {
  if (hasGuestSuffix(value)) return true;
  const name = normalizeName(value).toLocaleLowerCase();
  if (!name || !model || !meeting) return false;
  const person = readAttendees(model.rowsByLabel.get("Attendees")?.row[meeting.col]).find(p => normalizeName(p.name).toLocaleLowerCase() === name);
  if (person?.guest) return true;
  return [...model.rowsByLabel].some(([label, { row }]) => isAssignmentField(label) && normalizeName(row[meeting.col]).toLocaleLowerCase() === name && hasGuestSuffix(row[meeting.col]));
}
function guestRoleIcon(value) {
  if (!isGuestAssignment(value)) return "";
  return '<svg class="role-guest-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" role="img" aria-label="Guest"><title>Guest</title><circle cx="9" cy="7" r="3.5"/><path d="M2.5 21v-3.5a6.5 6.5 0 0 1 13 0V21M19 7v6m-3-3h6"/></svg>';
}
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
function tentativeIcon(label, value) {
  if (!isTentative(value)) return "";
  return `<span class="tentative-icon" title="Tentative" aria-label="${escapeHtml(label)} tentative">◷</span>`;
}
function displayAssignment(value) {
  return `${isTentative(value) ? TENTATIVE_PREFIX : ""}${normalizeName(value) || "Pending"}`;
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
    if (hasGuestSuffix(row[meeting.col])) people.get(key).guest = true;
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
    document.getElementById("attendeesList").replaceChildren();
    return;
  }
  document.getElementById("attendeesCount").textContent = people.length;
  if (!document.getElementById("attendeesDialog").open) return;
  document.getElementById("attendeesTitle").textContent = `${meeting ? formatMeetingDate(meeting.date) : ""} Attendees · ${people.length}`;
  document.getElementById("attendeesList").innerHTML = people.length ? people.map(person => `
    <li class="attendee-row"><strong>${escapeHtml(person.name)}</strong>
      <div class="attendee-roles">${person.roles.map(role => `<span>${role.tentative ? "◷ " : ""}${escapeHtml(role.label)}</span>`).join("")}</div>
      <span>${person.guest ? "Guest" : "Member"}</span>
    </li>`).join("") : '<li class="empty-state">참석자 없음</li>';
}
function initializeMeetingPeople() {
  const dialog = document.getElementById("attendeesDialog");
  const button = document.getElementById("attendeesButton");
  const popup = createAnchoredDialog(dialog, button, { onOpen: renderAttendees });
  document.getElementById("closeAttendeesDialog").addEventListener("click", () => { void popup.close(); });
}
