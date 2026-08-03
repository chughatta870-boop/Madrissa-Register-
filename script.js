'use strict';

/* ============ Storage Keys ============ */
const K_SETTINGS = 'mreg_settings_v1';
const K_STUDENTS = 'mreg_students_v1';
const K_ATTENDANCE = 'mreg_attendance_v1';

/* ============ State ============ */
let settings = loadJSON(K_SETTINGS, { madrissaName: 'Madrissa Attendance Register', incharge: '', address: '' });
let students = loadJSON(K_STUDENTS, []); // [{id, roll, name}]
let attendance = loadJSON(K_ATTENDANCE, {}); // { 'YYYY-MM-DD': { studentId: { Fajr:'P'|'A'|'L', Zuhr:..., Asr:..., Maghrib:..., Isha:... } } }

const PRAYERS = ['Fajr', 'Zuhr', 'Asr', 'Maghrib', 'Isha'];
const PRAYER_ICON = { Fajr: '\u{1F305}', Zuhr: '\u2600\uFE0F', Asr: '\u{1F324}\uFE0F', Maghrib: '\u{1F307}', Isha: '\u{1F319}' };

const GROUPS = ['Gazali', 'Babar', 'Qasim', 'Quaid', 'Iqbal', 'Shaheen', 'Khalid', 'Ghori'];
const GROUP_COLOR = {
  Gazali: '#6B4C9A', Babar: '#1F6F54', Qasim: '#C9622D', Quaid: '#1B4F72',
  Iqbal: '#A6321E', Shaheen: '#2E86AB', Khalid: '#8B6914', Ghori: '#555555'
};
const MARK_VALUE = { P: 5, L: 2, A: 0 }; // marks awarded per prayer attendance status

function defaultPrayerByTime() {
  const h = new Date().getHours();
  if (h < 7) return 'Fajr';
  if (h < 15) return 'Zuhr';
  if (h < 17) return 'Asr';
  if (h < 19) return 'Maghrib';
  return 'Isha';
}

/** One-time migration: old records stored a plain 'P'/'A'/'L' string per student per day.
 *  Convert those into the new per-prayer object shape so historical data isn't lost. */
function migrateAttendanceData() {
  let changed = false;
  Object.keys(attendance).forEach(date => {
    const dayRec = attendance[date];
    Object.keys(dayRec).forEach(studentId => {
      const val = dayRec[studentId];
      if (typeof val === 'string') {
        const obj = {};
        PRAYERS.forEach(p => { obj[p] = val; });
        dayRec[studentId] = obj;
        changed = true;
      }
    });
  });
  if (changed) saveAttendance();
}

let currentAttDate = todayStr();
let currentPrayer = defaultPrayerByTime();
let currentReportMonth = todayStr().slice(0, 7); // YYYY-MM
let currentPosPeriod = 'weekly';
let currentPosWeekRef = todayStr();
let currentPosMonth = todayStr().slice(0, 7);
let editingStudentId = null;
let confirmCallback = null;

/* ============ Helpers ============ */
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { showToast('Storage error: ' + e.message); }
}
function saveSettings() { saveJSON(K_SETTINGS, settings); }
function saveStudents() { saveJSON(K_STUDENTS, students); }
function saveAttendance() { saveJSON(K_ATTENDANCE, attendance); }

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function uid() { return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initials(name) {
  const parts = String(name).trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), 2400);
}
function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/* ============ Marks & Ranking Helpers ============ */
/** Returns the 7 date strings (Sun-Sat) for the week containing refDateStr */
function getWeekDates(refDateStr) {
  const d = new Date(refDateStr + 'T00:00:00');
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - d.getDay());
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const dd = new Date(sunday);
    dd.setDate(sunday.getDate() + i);
    dates.push(dd.getFullYear() + '-' + pad(dd.getMonth() + 1) + '-' + pad(dd.getDate()));
  }
  return dates;
}
function weekRangeLabel(refDateStr) {
  const dates = getWeekDates(refDateStr);
  const first = new Date(dates[0] + 'T00:00:00');
  const last = new Date(dates[6] + 'T00:00:00');
  const opts = { day: 'numeric', month: 'short' };
  const yearOpt = first.getFullYear() !== last.getFullYear() ? { year: 'numeric' } : {};
  return first.toLocaleDateString('en-US', { ...opts, ...yearOpt }) + ' - ' + last.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}
function datesForMonth(ym) {
  const dim = daysInMonth(ym);
  return Array.from({ length: dim }, (_, i) => ym + '-' + pad(i + 1));
}
/** Sums marks (P=5, L=2, A=0) for each student across the given dates/prayers. Returns array with a `marks` field added. */
function computeStudentMarks(dateList, prayerFilter) {
  const filterPrayers = prayerFilter && prayerFilter !== 'ALL' ? [prayerFilter] : PRAYERS;
  return students.map(s => {
    let marks = 0;
    dateList.forEach(date => {
      const rec = attendance[date] && attendance[date][s.id];
      if (!rec) return;
      filterPrayers.forEach(p => { marks += MARK_VALUE[rec[p]] || 0; });
    });
    return { ...s, marks };
  });
}
/** Ranks a list descending by valueKey, using tieKey to break ties. Equal values share the same position (1,2,2,4 style). */
function rankList(arr, valueKey, tieKey) {
  const sorted = [...arr].sort((a, b) => b[valueKey] - a[valueKey] || String(a[tieKey]).localeCompare(String(b[tieKey])));
  let rank = 0, prevVal = null;
  return sorted.map((item, idx) => {
    if (item[valueKey] !== prevVal) { rank = idx + 1; prevVal = item[valueKey]; }
    return { ...item, position: rank };
  });
}
function groupTag(groupName) {
  if (!groupName) return '<span class="group-tag unassigned">Unassigned</span>';
  const color = GROUP_COLOR[groupName] || '#888';
  return `<span class="group-tag" style="background:${color}">${escapeHtml(groupName)}</span>`;
}
function medalFor(position) {
  if (position === 1) return '<span class="pos-badge pos-1">&#129351;</span>';
  if (position === 2) return '<span class="pos-badge pos-2">&#129352;</span>';
  if (position === 3) return '<span class="pos-badge pos-3">&#129353;</span>';
  return `<span class="pos-badge pos-other">${position}</span>`;
}

/* ============ Navigation ============ */
const views = ['dashboard', 'attendance', 'students', 'positions', 'reports', 'settings'];
function goto(view) {
  views.forEach(v => {
    document.getElementById('view-' + v).classList.toggle('active', v === view);
  });
  document.querySelectorAll('.drawer-link[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  document.querySelectorAll('.bn-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  closeDrawer();
  if (view === 'dashboard') renderDashboard();
  if (view === 'attendance') renderAttendance();
  if (view === 'students') renderStudents();
  if (view === 'positions') renderPositions();
  if (view === 'reports') renderReport();
  window.scrollTo({ top: 0, behavior: 'auto' });
}
document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => goto(el.dataset.view)));
document.querySelectorAll('[data-goto]').forEach(el => el.addEventListener('click', () => goto(el.dataset.goto)));

function openDrawer() { document.getElementById('drawer').classList.add('open'); document.getElementById('drawerOverlay').classList.add('open'); }
function closeDrawer() { document.getElementById('drawer').classList.remove('open'); document.getElementById('drawerOverlay').classList.remove('open'); }
document.getElementById('menuBtn').addEventListener('click', openDrawer);
document.getElementById('drawerOverlay').addEventListener('click', closeDrawer);

/* ============ Header / Branding ============ */
function renderBranding() {
  document.getElementById('madrissaNameDisplay').textContent = settings.madrissaName || 'Madrissa Attendance Register';
  document.getElementById('inchargeDisplay').textContent = 'Incharge: ' + (settings.incharge || '--');
}

/* ============ Dashboard ============ */
function renderDashboard() {
  document.getElementById('statTotalStudents').textContent = students.length;
  const todayRec = attendance[todayStr()] || {};

  // aggregate across all 5 prayers for today
  let marked = 0, present = 0, absent = 0;
  students.forEach(s => {
    const rec = todayRec[s.id] || {};
    PRAYERS.forEach(p => {
      if (rec[p]) marked++;
      if (rec[p] === 'P') present++;
      if (rec[p] === 'A') absent++;
    });
  });
  document.getElementById('statTodayMarked').textContent = marked;
  document.getElementById('statPresentToday').textContent = present;
  document.getElementById('statAbsentToday').textContent = absent;
  document.getElementById('todayDateLabel').textContent = new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

  const list = document.getElementById('dashTodayList');
  if (students.length === 0) {
    list.innerHTML = '<p class="hint-text">No students added yet.</p>';
    return;
  }
  list.innerHTML = students.slice(0, 8).map(s => {
    const rec = todayRec[s.id] || {};
    const dots = PRAYERS.map(p => {
      const st = rec[p];
      const cls = st ? 'dot-' + st : 'dot-none';
      return `<span class="prayer-dot ${cls}" title="${p}${st ? ': ' + (st === 'P' ? 'Present' : st === 'A' ? 'Absent' : 'Leave') : ': not marked'}">${p[0]}</span>`;
    }).join('');
    return `<div class="today-row"><span>${escapeHtml(s.roll)} &middot; ${escapeHtml(s.name)}</span><span class="prayer-dots">${dots}</span></div>`;
  }).join('') + (students.length > 8 ? `<p class="hint-text">+ ${students.length - 8} more students</p>` : '');

  renderDashboardToppers();
}

function renderDashboardToppers() {
  const studentsBox = document.getElementById('dashToppersStudents');
  const groupsBox = document.getElementById('dashToppersGroups');
  if (students.length === 0) {
    studentsBox.innerHTML = '<p class="hint-text">No students added yet.</p>';
    groupsBox.innerHTML = '';
    return;
  }
  const weekDates = getWeekDates(todayStr());
  const marksData = computeStudentMarks(weekDates, 'ALL');
  const rankedStudents = rankList(marksData, 'marks', 'name').slice(0, 3);
  studentsBox.innerHTML = rankedStudents.map(s => `
    <div class="topper-row">
      <div class="topper-left">${medalFor(s.position)}<span class="topper-name">${escapeHtml(s.name)}</span></div>
      <span class="topper-marks">${s.marks} pts</span>
    </div>`).join('');

  const groupTotals = {};
  GROUPS.forEach(g => { groupTotals[g] = { marks: 0, count: 0 }; });
  marksData.forEach(s => {
    if (s.group && GROUPS.includes(s.group)) {
      groupTotals[s.group].marks += s.marks;
      groupTotals[s.group].count++;
    }
  });
  const groupArr = GROUPS.filter(g => groupTotals[g].count > 0).map(g => ({ group: g, marks: groupTotals[g].marks }));
  const rankedGroups = rankList(groupArr, 'marks', 'group').slice(0, 3);
  groupsBox.innerHTML = rankedGroups.length ? rankedGroups.map(g => `
    <div class="topper-row">
      <div class="topper-left">${medalFor(g.position)}${groupTag(g.group)}</div>
      <span class="topper-marks">${g.marks} pts</span>
    </div>`).join('') : '<p class="hint-text">Assign students to groups to see group standings.</p>';
}

/* ============ Students CRUD ============ */
function populateGroupSelects() {
  const modalSel = document.getElementById('modalStudentGroup');
  GROUPS.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g; opt.textContent = g;
    modalSel.appendChild(opt);
  });
  const filterSel = document.getElementById('studentGroupFilter');
  GROUPS.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g; opt.textContent = g;
    filterSel.appendChild(opt);
  });
}

function renderStudents() {
  const q = document.getElementById('studentSearch').value.trim().toLowerCase();
  const groupFilter = document.getElementById('studentGroupFilter').value;
  const list = document.getElementById('studentsList');
  const empty = document.getElementById('studentsEmpty');
  const filtered = students
    .filter(s => !q || s.name.toLowerCase().includes(q) || String(s.roll).toLowerCase().includes(q))
    .filter(s => groupFilter === 'ALL' || (groupFilter === 'UNASSIGNED' ? !s.group : s.group === groupFilter))
    .sort((a, b) => (a.roll + '').localeCompare(b.roll + '', undefined, { numeric: true }));

  if (students.length === 0) {
    list.innerHTML = ''; empty.classList.remove('hidden'); return;
  }
  empty.classList.add('hidden');
  if (filtered.length === 0) {
    list.innerHTML = '<p class="hint-text">No matching students.</p>';
    return;
  }
  list.innerHTML = filtered.map(s => `
    <div class="student-row">
      <div class="student-row-info">
        <div class="student-avatar">${escapeHtml(initials(s.name))}</div>
        <div>
          <div class="student-row-name">${escapeHtml(s.name)}</div>
          <div class="student-row-roll">Roll No: ${escapeHtml(s.roll)} &nbsp; ${groupTag(s.group)}</div>
        </div>
      </div>
      <div class="student-actions">
        <button data-edit="${s.id}" title="Edit">&#9998;</button>
        <button data-del="${s.id}" title="Delete">&#128465;</button>
      </div>
    </div>`).join('');

  list.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openStudentModal(b.dataset.edit)));
  list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    const s = students.find(x => x.id === b.dataset.del);
    confirmAction(`Delete student "${s.name}"? Their attendance history will also be removed.`, () => {
      students = students.filter(x => x.id !== s.id);
      Object.keys(attendance).forEach(date => { delete attendance[date][s.id]; });
      saveStudents(); saveAttendance();
      renderStudents(); showToast('Student deleted');
    });
  }));
}
document.getElementById('studentSearch').addEventListener('input', renderStudents);
document.getElementById('studentGroupFilter').addEventListener('change', renderStudents);
document.getElementById('addStudentBtn').addEventListener('click', () => openStudentModal(null));

function openStudentModal(id) {
  editingStudentId = id;
  const overlay = document.getElementById('studentModalOverlay');
  const title = document.getElementById('studentModalTitle');
  const rollEl = document.getElementById('modalRollNo');
  const nameEl = document.getElementById('modalStudentName');
  const groupEl = document.getElementById('modalStudentGroup');
  if (id) {
    const s = students.find(x => x.id === id);
    title.textContent = 'Edit Student';
    rollEl.value = s.roll; nameEl.value = s.name; groupEl.value = s.group || '';
  } else {
    title.textContent = 'Add Student';
    rollEl.value = suggestNextRoll(); nameEl.value = ''; groupEl.value = '';
  }
  overlay.classList.add('open');
  setTimeout(() => nameEl.focus(), 100);
}
function suggestNextRoll() {
  const nums = students.map(s => parseInt(s.roll, 10)).filter(n => !isNaN(n));
  return nums.length ? String(Math.max(...nums) + 1) : '1';
}
function closeStudentModal() { document.getElementById('studentModalOverlay').classList.remove('open'); editingStudentId = null; }
document.getElementById('closeStudentModal').addEventListener('click', closeStudentModal);
document.getElementById('cancelStudentModal').addEventListener('click', closeStudentModal);
document.getElementById('studentModalOverlay').addEventListener('click', e => { if (e.target.id === 'studentModalOverlay') closeStudentModal(); });

document.getElementById('saveStudentModal').addEventListener('click', () => {
  const roll = document.getElementById('modalRollNo').value.trim();
  const name = document.getElementById('modalStudentName').value.trim();
  const group = document.getElementById('modalStudentGroup').value;
  if (!name) { showToast('Please enter student name'); return; }
  if (!roll) { showToast('Please enter roll number'); return; }
  if (editingStudentId) {
    const s = students.find(x => x.id === editingStudentId);
    s.roll = roll; s.name = name; s.group = group;
    showToast('Student updated');
  } else {
    students.push({ id: uid(), roll, name, group });
    showToast('Student added');
  }
  saveStudents();
  closeStudentModal();
  renderStudents();
  renderDashboard();
});

/* ============ Confirm Dialog ============ */
function confirmAction(msg, cb) {
  document.getElementById('confirmMessage').textContent = msg;
  confirmCallback = cb;
  document.getElementById('confirmOverlay').classList.add('open');
}
document.getElementById('confirmCancel').addEventListener('click', () => { document.getElementById('confirmOverlay').classList.remove('open'); confirmCallback = null; });
document.getElementById('confirmOk').addEventListener('click', () => {
  document.getElementById('confirmOverlay').classList.remove('open');
  if (confirmCallback) confirmCallback();
  confirmCallback = null;
});

/* ============ Daily Attendance ============ */
function renderPrayerChips() {
  const wrap = document.getElementById('prayerChipsRow');
  wrap.innerHTML = PRAYERS.map(p => `
    <button class="prayer-chip prayer-${p} ${p === currentPrayer ? 'active' : ''}" data-prayer="${p}">
      <span>${PRAYER_ICON[p]}</span>${p}
    </button>`).join('');
  wrap.querySelectorAll('[data-prayer]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPrayer = btn.dataset.prayer;
      renderPrayerChips();
      renderAttendance();
    });
  });
}

function renderAttendance() {
  document.getElementById('attendanceDate').value = currentAttDate;
  const q = document.getElementById('attSearch').value.trim().toLowerCase();
  const list = document.getElementById('attendanceList');
  const empty = document.getElementById('attEmptyState');
  const dayRec = attendance[currentAttDate] || {};

  if (students.length === 0) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  const filtered = students
    .filter(s => !q || s.name.toLowerCase().includes(q) || String(s.roll).toLowerCase().includes(q))
    .sort((a, b) => (a.roll + '').localeCompare(b.roll + '', undefined, { numeric: true }));

  list.innerHTML = filtered.map(s => {
    const rec = dayRec[s.id] || {};
    const st = rec[currentPrayer];
    return `
    <div class="att-row" data-id="${s.id}">
      <div class="att-row-info">
        <div class="att-row-name">${escapeHtml(s.name)}</div>
        <div class="att-row-roll">Roll No: ${escapeHtml(s.roll)}</div>
      </div>
      <div class="att-buttons">
        <button class="att-btn p ${st === 'P' ? 'active' : ''}" data-status="P" title="Present">P</button>
        <button class="att-btn a ${st === 'A' ? 'active' : ''}" data-status="A" title="Absent">A</button>
        <button class="att-btn l ${st === 'L' ? 'active' : ''}" data-status="L" title="Leave">L</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.att-row').forEach(row => {
    const id = row.dataset.id;
    row.querySelectorAll('.att-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const status = btn.dataset.status;
        if (!attendance[currentAttDate]) attendance[currentAttDate] = {};
        if (!attendance[currentAttDate][id]) attendance[currentAttDate][id] = {};
        const cur = attendance[currentAttDate][id][currentPrayer];
        if (cur === status) {
          delete attendance[currentAttDate][id][currentPrayer]; // toggle off
        } else {
          attendance[currentAttDate][id][currentPrayer] = status;
        }
        saveAttendance();
        renderAttendance();
      });
    });
  });
}
document.getElementById('attSearch').addEventListener('input', renderAttendance);
document.getElementById('attendanceDate').addEventListener('change', e => { currentAttDate = e.target.value || todayStr(); renderAttendance(); });
document.getElementById('dateBack').addEventListener('click', () => shiftDate(-1));
document.getElementById('dateFwd').addEventListener('click', () => shiftDate(1));
document.getElementById('dateToday').addEventListener('click', () => { currentAttDate = todayStr(); renderAttendance(); });
function shiftDate(delta) {
  const d = new Date(currentAttDate + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  currentAttDate = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  renderAttendance();
}
document.querySelectorAll('[data-markall]').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.markall;
    if (students.length === 0) return;
    if (!attendance[currentAttDate]) attendance[currentAttDate] = {};
    if (mode === 'clear') {
      students.forEach(s => {
        if (attendance[currentAttDate][s.id]) delete attendance[currentAttDate][s.id][currentPrayer];
      });
    } else {
      students.forEach(s => {
        if (!attendance[currentAttDate][s.id]) attendance[currentAttDate][s.id] = {};
        attendance[currentAttDate][s.id][currentPrayer] = mode;
      });
    }
    saveAttendance();
    renderAttendance();
    showToast(mode === 'clear' ? `Cleared ${currentPrayer} attendance for the day` : `Marked all students for ${currentPrayer}`);
  });
});

/* ============ Positions (Weekly/Monthly, Individual + Group) ============ */
function currentPosPrayerLabel() {
  const v = document.getElementById('posPrayerFilter').value;
  return v === 'ALL' ? 'All Prayers (Combined)' : v;
}
function currentPosDateList() {
  return currentPosPeriod === 'weekly' ? getWeekDates(currentPosWeekRef) : datesForMonth(currentPosMonth);
}
function currentPosPeriodLabel() {
  return currentPosPeriod === 'weekly' ? 'Week of ' + weekRangeLabel(currentPosWeekRef) : monthLabel(currentPosMonth);
}

function renderPositions() {
  document.getElementById('weekLabel').textContent = weekRangeLabel(currentPosWeekRef);
  document.getElementById('posReportMonth').value = currentPosMonth;

  const dateList = currentPosDateList();
  const prayerFilter = document.getElementById('posPrayerFilter').value;
  const marksData = computeStudentMarks(dateList, prayerFilter);
  const rankedStudents = rankList(marksData, 'marks', 'name');

  const studentTbody = document.getElementById('studentPosTbody');
  if (students.length === 0) {
    studentTbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--ink-soft);padding:20px;">No students added yet.</td></tr>`;
  } else {
    studentTbody.innerHTML = rankedStudents.map(s => `
      <tr>
        <td>${medalFor(s.position)}</td>
        <td>${escapeHtml(s.roll)}</td>
        <td>${escapeHtml(s.name)}</td>
        <td>${groupTag(s.group)}</td>
        <td><strong>${s.marks}</strong></td>
      </tr>`).join('');
  }

  const groupTotals = {};
  GROUPS.forEach(g => { groupTotals[g] = { marks: 0, count: 0 }; });
  let unassignedCount = 0;
  marksData.forEach(s => {
    if (s.group && GROUPS.includes(s.group)) {
      groupTotals[s.group].marks += s.marks;
      groupTotals[s.group].count++;
    } else {
      unassignedCount++;
    }
  });
  const groupArr = GROUPS.filter(g => groupTotals[g].count > 0).map(g => ({
    group: g, marks: groupTotals[g].marks, count: groupTotals[g].count,
    avg: groupTotals[g].count ? Math.round((groupTotals[g].marks / groupTotals[g].count) * 10) / 10 : 0
  }));
  const rankedGroups = rankList(groupArr, 'marks', 'group');
  const groupTbody = document.getElementById('groupPosTbody');
  groupTbody.innerHTML = rankedGroups.length
    ? rankedGroups.map(g => `
      <tr>
        <td>${medalFor(g.position)}</td>
        <td>${groupTag(g.group)}</td>
        <td>${g.count}</td>
        <td><strong>${g.marks}</strong></td>
        <td>${g.avg}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" style="text-align:center;color:var(--ink-soft);padding:20px;">No students assigned to groups yet.</td></tr>`;

  document.getElementById('unassignedNote').textContent = unassignedCount > 0
    ? `${unassignedCount} student(s) not yet assigned to a group are excluded from group standings. Edit their profile in Students to assign one.`
    : '';
}

document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentPosPeriod = btn.dataset.period;
    document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('weekRow').classList.toggle('hidden', currentPosPeriod !== 'weekly');
    document.getElementById('posMonthRow').classList.toggle('hidden', currentPosPeriod !== 'monthly');
    renderPositions();
  });
});
document.getElementById('weekBack').addEventListener('click', () => shiftPosWeek(-7));
document.getElementById('weekFwd').addEventListener('click', () => shiftPosWeek(7));
function shiftPosWeek(deltaDays) {
  const d = new Date(currentPosWeekRef + 'T00:00:00');
  d.setDate(d.getDate() + deltaDays);
  currentPosWeekRef = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  renderPositions();
}
document.getElementById('posMonthBack').addEventListener('click', () => shiftPosMonth(-1));
document.getElementById('posMonthFwd').addEventListener('click', () => shiftPosMonth(1));
function shiftPosMonth(delta) {
  const [y, m] = currentPosMonth.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  currentPosMonth = d.getFullYear() + '-' + pad(d.getMonth() + 1);
  renderPositions();
}
document.getElementById('posReportMonth').addEventListener('change', e => { currentPosMonth = e.target.value || currentPosMonth; renderPositions(); });
document.getElementById('posPrayerFilter').addEventListener('change', renderPositions);

function buildStudentPosCsv() {
  const dateList = currentPosDateList();
  const marksData = computeStudentMarks(dateList, document.getElementById('posPrayerFilter').value);
  const ranked = rankList(marksData, 'marks', 'name');
  const rows = [
    [settings.madrissaName || 'Madrissa'],
    ['Incharge: ' + (settings.incharge || '--')],
    ['Student Positions - ' + currentPosPeriodLabel()],
    ['Prayer: ' + currentPosPrayerLabel()],
    ['Marks per prayer: Present=5, Leave=2, Absent=0'],
    [],
    ['Position', 'Roll No', 'Name', 'Group', 'Marks'],
    ...ranked.map(s => [s.position, s.roll, s.name, s.group || 'Unassigned', s.marks]),
    [],
    ['Generated by M Ijaz - GHS 124/NB'],
  ];
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}
function buildGroupPosCsv() {
  const dateList = currentPosDateList();
  const marksData = computeStudentMarks(dateList, document.getElementById('posPrayerFilter').value);
  const groupTotals = {};
  GROUPS.forEach(g => { groupTotals[g] = { marks: 0, count: 0 }; });
  marksData.forEach(s => { if (s.group && GROUPS.includes(s.group)) { groupTotals[s.group].marks += s.marks; groupTotals[s.group].count++; } });
  const groupArr = GROUPS.filter(g => groupTotals[g].count > 0).map(g => ({ group: g, marks: groupTotals[g].marks, count: groupTotals[g].count, avg: Math.round((groupTotals[g].marks / groupTotals[g].count) * 10) / 10 }));
  const ranked = rankList(groupArr, 'marks', 'group');
  const rows = [
    [settings.madrissaName || 'Madrissa'],
    ['Incharge: ' + (settings.incharge || '--')],
    ['Group Positions - ' + currentPosPeriodLabel()],
    ['Prayer: ' + currentPosPrayerLabel()],
    [],
    ['Position', 'Group', 'Students', 'Total Marks', 'Average'],
    ...ranked.map(g => [g.position, g.group, g.count, g.marks, g.avg]),
    [],
    ['Generated by M Ijaz - GHS 124/NB'],
  ];
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}
function buildStudentPosShareText() {
  const dateList = currentPosDateList();
  const marksData = computeStudentMarks(dateList, document.getElementById('posPrayerFilter').value);
  const ranked = rankList(marksData, 'marks', 'name');
  let text = `${settings.madrissaName || 'Madrissa'}\nStudent Positions - ${currentPosPeriodLabel()}\nPrayer: ${currentPosPrayerLabel()}\n\n`;
  ranked.forEach(s => { text += `${s.position}. ${s.name} (${s.group || 'Unassigned'}) - ${s.marks} pts\n`; });
  text += `\nGenerated via Madrissa Attendance Register\nM Ijaz \u00b7 GHS 124/NB`;
  return text;
}
function buildGroupPosShareText() {
  const dateList = currentPosDateList();
  const marksData = computeStudentMarks(dateList, document.getElementById('posPrayerFilter').value);
  const groupTotals = {};
  GROUPS.forEach(g => { groupTotals[g] = { marks: 0, count: 0 }; });
  marksData.forEach(s => { if (s.group && GROUPS.includes(s.group)) { groupTotals[s.group].marks += s.marks; groupTotals[s.group].count++; } });
  const groupArr = GROUPS.filter(g => groupTotals[g].count > 0).map(g => ({ group: g, marks: groupTotals[g].marks }));
  const ranked = rankList(groupArr, 'marks', 'group');
  let text = `${settings.madrissaName || 'Madrissa'}\nGroup Positions - ${currentPosPeriodLabel()}\nPrayer: ${currentPosPrayerLabel()}\n\n`;
  ranked.forEach(g => { text += `${g.position}. ${g.group} - ${g.marks} pts\n`; });
  text += `\nGenerated via Madrissa Attendance Register\nM Ijaz \u00b7 GHS 124/NB`;
  return text;
}
document.getElementById('posStudentCsv').addEventListener('click', () => {
  downloadBlob(buildStudentPosCsv(), `student-positions-${currentPosPeriod}-${todayStr()}.csv`, 'text/csv');
  showToast('CSV downloaded');
});
document.getElementById('posGroupCsv').addEventListener('click', () => {
  downloadBlob(buildGroupPosCsv(), `group-positions-${currentPosPeriod}-${todayStr()}.csv`, 'text/csv');
  showToast('CSV downloaded');
});
document.getElementById('posStudentShare').addEventListener('click', async () => {
  await shareContent('Student Positions', buildStudentPosShareText(), buildStudentPosCsv(), `student-positions-${todayStr()}.csv`, 'text/csv');
});
document.getElementById('posGroupShare').addEventListener('click', async () => {
  await shareContent('Group Positions', buildGroupPosShareText(), buildGroupPosCsv(), `group-positions-${todayStr()}.csv`, 'text/csv');
});

/* ============ Monthly Reports ============ */
function computeMonthlyStats(ym, prayerFilter) {
  const dim = daysInMonth(ym);
  const filterPrayers = prayerFilter && prayerFilter !== 'ALL' ? [prayerFilter] : PRAYERS;
  return students.map(s => {
    let P = 0, A = 0, L = 0;
    for (let d = 1; d <= dim; d++) {
      const date = ym + '-' + pad(d);
      const rec = attendance[date] && attendance[date][s.id];
      if (!rec) continue;
      filterPrayers.forEach(p => {
        const st = rec[p];
        if (st === 'P') P++; else if (st === 'A') A++; else if (st === 'L') L++;
      });
    }
    const total = P + A + L;
    const pct = total ? Math.round((P / total) * 1000) / 10 : 0;
    return { ...s, P, A, L, total, pct };
  }).sort((a, b) => (a.roll + '').localeCompare(b.roll + '', undefined, { numeric: true }));
}

function renderReport() {
  document.getElementById('reportMonth').value = currentReportMonth;
  const q = document.getElementById('reportSearch').value.trim().toLowerCase();
  const prayerFilter = document.getElementById('reportPrayerFilter').value;
  const stats = computeMonthlyStats(currentReportMonth, prayerFilter).filter(s => !q || s.name.toLowerCase().includes(q) || String(s.roll).toLowerCase().includes(q));
  const tbody = document.getElementById('reportTbody');
  if (students.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--ink-soft);padding:20px;">No students added yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = stats.map(s => {
    const pctClass = s.pct >= 75 ? 'pct-good' : s.pct >= 50 ? 'pct-mid' : 'pct-bad';
    return `<tr>
      <td>${escapeHtml(s.roll)}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${s.P}</td>
      <td>${s.A}</td>
      <td>${s.L}</td>
      <td>${s.total}</td>
      <td class="${pctClass}">${s.pct}%</td>
    </tr>`;
  }).join('');
}
document.getElementById('reportSearch').addEventListener('input', renderReport);
document.getElementById('reportPrayerFilter').addEventListener('change', renderReport);
document.getElementById('reportMonth').addEventListener('change', e => { currentReportMonth = e.target.value || currentReportMonth; renderReport(); });
document.getElementById('monthBack').addEventListener('click', () => shiftMonth(-1));
document.getElementById('monthFwd').addEventListener('click', () => shiftMonth(1));
function shiftMonth(delta) {
  const [y, m] = currentReportMonth.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  currentReportMonth = d.getFullYear() + '-' + pad(d.getMonth() + 1);
  renderReport();
}

function buildCsv() {
  const prayerFilter = document.getElementById('reportPrayerFilter').value;
  const label = prayerFilter === 'ALL' ? 'All Prayers (Combined)' : prayerFilter;
  const stats = computeMonthlyStats(currentReportMonth, prayerFilter);
  const rows = [
    [settings.madrissaName || 'Madrissa'],
    ['Incharge: ' + (settings.incharge || '--')],
    ['Monthly Attendance Report - ' + monthLabel(currentReportMonth)],
    ['Prayer: ' + label],
    [],
    ['Roll No', 'Name', 'Present', 'Absent', 'Leave', 'Total Marked', 'Percentage'],
    ...stats.map(s => [s.roll, s.name, s.P, s.A, s.L, s.total, s.pct + '%']),
    [],
    ['Generated by M Ijaz - GHS 124/NB'],
  ];
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

document.getElementById('reportDownloadCsv').addEventListener('click', () => {
  const csv = buildCsv();
  downloadBlob(csv, `attendance-report-${currentReportMonth}.csv`, 'text/csv');
  showToast('CSV downloaded');
});

document.getElementById('reportDownloadPdf').addEventListener('click', () => {
  goto('reports');
  setTimeout(() => window.print(), 150);
});

document.getElementById('reportShare').addEventListener('click', async () => {
  const text = buildShareText();
  await shareContent('Monthly Attendance Report', text, buildCsv(), `attendance-report-${currentReportMonth}.csv`, 'text/csv');
});
document.getElementById('qaShare').addEventListener('click', async () => {
  const text = buildShareText();
  await shareContent('Attendance Report', text, buildCsv(), `attendance-report-${currentReportMonth}.csv`, 'text/csv');
});

function buildShareText() {
  const prayerFilter = document.getElementById('reportPrayerFilter').value;
  const label = prayerFilter === 'ALL' ? 'All Prayers (Combined)' : prayerFilter;
  const stats = computeMonthlyStats(currentReportMonth, prayerFilter);
  let text = `${settings.madrissaName || 'Madrissa'}\nIncharge: ${settings.incharge || '--'}\nMonthly Report - ${monthLabel(currentReportMonth)}\nPrayer: ${label}\n\n`;
  stats.forEach(s => { text += `${s.roll}. ${s.name} - P:${s.P} A:${s.A} L:${s.L} (${s.pct}%)\n`; });
  text += `\nGenerated via Madrissa Attendance Register\nM Ijaz \u00b7 GHS 124/NB`;
  return text;
}

async function shareContent(title, text, fileContent, fileName, mime) {
  try {
    if (navigator.share) {
      if (navigator.canShare && fileContent) {
        const file = new File([fileContent], fileName, { type: mime });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ title, text, files: [file] });
          return;
        }
      }
      await navigator.share({ title, text });
    } else {
      await navigator.clipboard.writeText(text);
      showToast('Share not supported — copied to clipboard');
    }
  } catch (e) {
    if (e.name !== 'AbortError') showToast('Could not share');
  }
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ============ Settings ============ */
function renderSettingsForm() {
  document.getElementById('settingMadrissaName').value = settings.madrissaName || '';
  document.getElementById('settingIncharge').value = settings.incharge || '';
  document.getElementById('settingAddress').value = settings.address || '';
}
document.getElementById('saveSettingsBtn').addEventListener('click', () => {
  settings.madrissaName = document.getElementById('settingMadrissaName').value.trim() || 'Madrissa Attendance Register';
  settings.incharge = document.getElementById('settingIncharge').value.trim();
  settings.address = document.getElementById('settingAddress').value.trim();
  saveSettings();
  renderBranding();
  showToast('Settings saved');
});

/* ============ Backup / Restore ============ */
function buildBackupObject() {
  return { app: 'madrissa-attendance-register', version: 1, exportedAt: new Date().toISOString(), settings, students, attendance };
}
function downloadBackup() {
  const data = JSON.stringify(buildBackupObject(), null, 2);
  downloadBlob(data, `madrissa-backup-${todayStr()}.json`, 'application/json');
  showToast('Backup downloaded');
}
document.getElementById('settingsDownloadBackup').addEventListener('click', downloadBackup);
document.getElementById('qaDownload').addEventListener('click', downloadBackup);
document.getElementById('backupBtn').addEventListener('click', () => { goto('settings'); });

document.getElementById('restoreFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || typeof data !== 'object') throw new Error('Invalid file');
      confirmAction('Restore from this backup? Current data will be replaced.', () => {
        settings = data.settings || settings;
        students = data.students || [];
        attendance = data.attendance || {};
        saveSettings(); saveStudents(); saveAttendance();
        renderBranding(); renderSettingsForm(); renderDashboard();
        showToast('Backup restored');
      });
    } catch (err) {
      showToast('Invalid backup file');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('clearAllBtn').addEventListener('click', () => {
  confirmAction('Erase ALL data (students, attendance, settings)? This cannot be undone.', () => {
    localStorage.removeItem(K_SETTINGS);
    localStorage.removeItem(K_STUDENTS);
    localStorage.removeItem(K_ATTENDANCE);
    settings = { madrissaName: 'Madrissa Attendance Register', incharge: '', address: '' };
    students = []; attendance = {};
    renderBranding(); renderSettingsForm(); renderDashboard(); renderStudents(); renderAttendance(); renderPositions(); renderReport();
    showToast('All data erased');
  });
});

/* ============ Init ============ */
function init() {
  migrateAttendanceData();
  populateGroupSelects();
  renderBranding();
  renderSettingsForm();
  renderDashboard();
  renderStudents();
  renderPrayerChips();
  renderAttendance();
  renderPositions();
  renderReport();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
}
init();
