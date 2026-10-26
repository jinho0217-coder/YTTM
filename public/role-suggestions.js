// Match last meeting's participants to empty roles, favoring roles new to them.
function suggestMeetingRoles(model, meeting) {
  if (!meeting || meeting.noMeeting) return { previous: null, items: [] };
  const previous = model.columns.filter(column => !column.noMeeting && column.date < meeting.date && column.date < meetingReferenceDateKst())
    .sort((a, b) => b.date - a.date).find(column => meetingAttendees(model, column).length);
  if (!previous) return { previous: null, items: [] };
  const occupied = new Set(meetingAttendees(model, meeting, { includeTentative: true }).filter(p => p.roles.length).map(p => p.name.toLocaleLowerCase()));
  const candidates = meetingAttendees(model, previous).filter(person => !person.guest && !occupied.has(person.name.toLocaleLowerCase()));
  const evaluatorFields = [1, 2, 3, 4].filter(slot => normalizeName(model.rowsByLabel.get(`Speaker ${slot}`)?.row[meeting.col])).map(slot => `Evaluator ${slot}`);
  const fields = [...ROLE_EDIT_FIELDS, ...evaluatorFields].filter(label => model.rowsByLabel.has(label) && !clean(model.rowsByLabel.get(label).row[meeting.col]));
  const history = [];
  model.rowsByLabel.forEach(({ row }, label) => {
    if (!isRoleRow(label)) return;
    model.columns.filter(c => c.date < meeting.date && c.date < meetingReferenceDateKst() && !c.noMeeting).forEach(column => {
      if (confirmedAssignment(row[column.col])) history.push({ name: normalizeName(row[column.col]).toLocaleLowerCase(), role: canonicalRole(label), col: column.col });
    });
  });
  let choices = new Map([[0, { cost: 0, items: [] }]]);
  candidates.forEach(person => {
    const next = new Map(choices);
    const past = history.filter(item => item.name === person.name.toLocaleLowerCase());
    choices.forEach((choice, mask) => fields.forEach((label, index) => {
      if (mask & (1 << index)) return;
      const count = past.filter(item => item.role === canonicalRole(label)).length;
      const repeatedLastTime = past.some(item => item.col === previous.col && item.role === canonicalRole(label));
      const cost = choice.cost + (count ? 100000 + count * 1000 : 0) + (repeatedLastTime ? 100 : 0) + past.length;
      const key = mask | (1 << index);
      if (!next.has(key) || cost < next.get(key).cost) next.set(key, { cost, items: [...choice.items, { label, name: person.name, count }] });
    }));
    choices = next;
  });
  const best = [...choices.values()].sort((a, b) => b.items.length - a.items.length || a.cost - b.cost)[0];
  return { previous, items: (best?.items || []).sort((a, b) => fields.indexOf(a.label) - fields.indexOf(b.label)) };
}
function openRoleSuggestions() {
  const meeting = activeMeeting();
  if (!meeting || !canEditActiveMeeting() || meeting.noMeeting) return;
  const suggestion = suggestMeetingRoles(state.model, meeting);
  state.roleSuggestion = { ...suggestion, meetingDate: sheetDateValue(meeting.date), versions: localFieldVersions() };
  document.getElementById('roleSuggestionsTitle').textContent = `${formatMeetingDate(meeting.date)} · Suggested roles`;
  document.getElementById('roleSuggestionsList').innerHTML = suggestion.items.length ? suggestion.items.map((item, index) =>
    `<label class="suggestion-row" title="${item.count ? `${item.count} previous assignments` : 'New role'} · ${suggestion.previous ? formatMeetingDate(suggestion.previous.date) : ''}"><input type="checkbox" data-suggestion-index="${index}" checked><span>${escapeHtml(item.label)}</span><strong>◷ ${escapeHtml(item.name)}</strong>${item.count ? '' : '<span class="new-role-mark" title="New role" aria-label="New role">✦</span>'}</label>`).join('') : '<div class="empty-state">No available candidates or empty roles.</div>';
  document.getElementById('applyRoleSuggestions').disabled = !suggestion.items.length || !WRITE_ENDPOINT;
  document.getElementById('roleSuggestionsStatus').textContent = '';
  document.getElementById('roleSuggestionsDialog').showModal();
}
function initializeRoleSuggestions() {
  document.getElementById('roleSuggestionsButton').addEventListener('click', openRoleSuggestions);
  document.getElementById('closeRoleSuggestionsDialog').addEventListener('click', () => document.getElementById('roleSuggestionsDialog').close());
  document.getElementById('applyRoleSuggestions').addEventListener('click', () => {
    const suggestion = state.roleSuggestion;
    try {
      const meeting = activeMeeting();
      if (!meeting || sheetDateValue(meeting.date) !== suggestion.meetingDate) throw new Error('The meeting changed. Open suggestions again.');
      const items = [...document.querySelectorAll('[data-suggestion-index]:checked')].map(input => suggestion.items[Number(input.dataset.suggestionIndex)]);
      if (!items.length) return;
      const people = meetingAttendees(state.model, meeting, { includeTentative: true });
      if (items.some(item => editableValue(meeting, item.label) || people.some(person => person.roles.length && person.name.toLocaleLowerCase() === item.name.toLocaleLowerCase()))) throw new Error('Assignments changed. Open suggestions again.');
      const groups = groupSuggestedAssignments(items);
      Object.entries(groups).forEach(([section, updates]) => savePeopleUpdates(section, updates, suggestion.versions));
      document.getElementById('roleSuggestionsDialog').close();
    } catch (error) { document.getElementById('roleSuggestionsStatus').textContent = error.message; }
  });
}

function groupSuggestedAssignments(items) {
  const groups = {};
  items.forEach(item => {
    const section = /^Evaluator [1-4]$/.test(item.label) ? 'speeches' : 'roles';
    groups[section] ||= {};
    groups[section][item.label] = TENTATIVE_PREFIX + item.name;
  });
  return groups;
}
