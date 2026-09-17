// Dashboard state and DOM references.
const state = { hallTicket: sessionStorage.getItem('attendance-ticket') };
const content = document.querySelector('#dashboard-content');
const loadingPanel = document.querySelector('#loading-panel');
const errorPanel = document.querySelector('#error-panel');
const refreshButton = document.querySelector('#refresh-button');
let activeSection = 'attendance';
let activeDate = '';
let latestRequestId = 0;
let bonafideResizeObserver = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function initialsFromName(name) {
  return String(name || 'Student').trim().split(/\s+/).slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase()).join('') || 'S';
}

function setLoading(isLoading) {
  loadingPanel.hidden = !isLoading;
  content.hidden = isLoading;
  errorPanel.hidden = true;
  refreshButton.disabled = isLoading;
}

function setActiveNavigation(section) {
  document.querySelectorAll('[data-section]').forEach((button) => {
    button.classList.toggle('active', button.dataset.section === section);
  });
}

function clearBonafideResizeObserver() {
  bonafideResizeObserver?.disconnect();
  bonafideResizeObserver = null;
}

function renderAttendanceMaintenance() {
  content.innerHTML = `
    <section class="maintenance-card">
      <p class="eyebrow">ATTENDANCE</p>
      <h1>🚧 Attendance System Under Maintenance</h1>
      <p>'Overall attendance' server is taking a little break 😴</p>
      <p>Please use 'Daily' Attendance to check attendance for a specific date.</p>
      <div class="maintenance-status" aria-label="Attendance availability">
        <div><strong>Overall Attendance</strong><span>Temporarily unavailable</span></div>
        <div><strong>Daily Attendance</strong><span>Available ✅</span></div>
      </div>
      <p>Don't worry, your attendance just gone on a vacation! 😄</p>
      <button class="refresh-button" id="maintenance-daily-button">Daily Attendance</button>
    </section>
  `;
  document.querySelector('#maintenance-daily-button').addEventListener('click', () => loadSection('daily-reports'));
}

function renderAllDatesMaintenance() {
  content.innerHTML = `
    <section class="maintenance-card">
      <p class="eyebrow">ATTENDANCE HISTORY</p>
      <h1>🚧 All Dates is Taking a Break</h1>
      <p>The All Dates attendance view is temporarily unavailable while we fix things behind the scenes.</p>
      <p>Please use Daily Attendance to check attendance for a specific date.</p>
      <p>Your attendance hasn't disappeared — this section is just taking a small break 😴</p>
      <button class="refresh-button" id="maintenance-daily-button">Go to Daily Attendance</button>
    </section>
  `;
  document.querySelector('#maintenance-daily-button').addEventListener('click', () => loadSection('daily-reports'));
}

function renderSectionError(message) {
  content.innerHTML = `
    <section class="empty-state">
      <h2>Unable to load this information</h2>
      <p>${escapeHtml(message || 'Something went wrong. Please try again.')}</p>
      <button class="refresh-button" id="section-retry">Try Again</button>
    </section>
  `;
  content.hidden = false;
  document.querySelector('#section-retry').addEventListener('click', () => loadSection(activeSection, activeDate));
}

// This is the only section renderer. Maintenance sections are frontend-only.
function renderSection(section, data = {}) {
  clearBonafideResizeObserver();

  if (section === 'attendance') {
    renderAttendanceMaintenance();
  } else if (section === 'all-dates') {
    renderAllDatesMaintenance();
  } else if (section === 'profile') {
    const fields = Object.entries(data.fields || {});
    const studentName = data.fields?.['Student Name'] || 'Student';
    content.innerHTML = `
      <section class="section-heading"><div><p class="eyebrow">STUDENT PROFILE</p><h2>Your profile</h2></div></section>
      <section class="profile-hero"><div class="profile-photo-ring">${data.photoUrl
        ? `<img src="${escapeHtml(data.photoUrl)}" alt="${escapeHtml(studentName)}">`
        : `<div class="student-avatar">${escapeHtml(initialsFromName(studentName))}</div>`}</div><strong>${escapeHtml(studentName)}</strong></section>
      <section class="profile-list">${fields.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('') || '<p class="empty-state">No profile information available.</p>'}</section>
    `;
  } else if (section === 'daily-reports') {
    const options = (data.availableDates || []).map((date) => `<option value="${escapeHtml(date.value)}">${escapeHtml(date.label)}</option>`).join('');
    const records = (data.records || []).map((row) => `<div><strong>${escapeHtml(row.subject)}${row.hour ? ` · Hour ${escapeHtml(row.hour)}` : ''}</strong><span>${row.attended ? 'Present' : 'Absent'} · ${row.attended}/${row.conducted}</span></div>`).join('');
    content.innerHTML = `
      <section class="section-heading"><div><p class="eyebrow">DAILY ATTENDANCE</p><h2>Daily report</h2></div></section>
      <label class="date-picker">Choose date<select id="daily-date"><option value="">Select a date</option>${options}</select></label>
      <section class="report-list">${records || '<p class="empty-state">Choose a date to view its report.</p>'}</section>
    `;
    document.querySelector('#daily-date').value = data.selectedDate || '';
    document.querySelector('#daily-date').addEventListener('change', (event) => loadSection('daily-reports', event.target.value));
  } else if (section === 'results') {
    const semesters = (data.records || []).reduce((groups, record) => {
      const key = `Year ${record.year} · Semester ${record.semester}`;
      (groups[key] ||= []).push(record);
      return groups;
    }, {});
    content.innerHTML = `
      <section class="section-heading"><div><p class="eyebrow">ACADEMIC RESULTS</p><h2>Academic results</h2></div><button class="plain-button" id="backlogs-button">→ Backlogs (${(data.backlogs || []).length})</button></section>
      <section class="profile-list result-summary">${[['Name', data.summary?.name], ['Hall No', data.summary?.hallTicket], ['CGPA', data.summary?.cgpa], ['Percentage', data.summary?.percentage ? `${data.summary.percentage}%` : ''], ['Credits', data.summary?.credits]].filter(([, value]) => value).map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</section>
      <section class="results-list">${Object.entries(semesters).map(([semester, records]) => `<section class="semester-group"><h3>${escapeHtml(semester)}</h3>${records.map((record) => {
        const externalMarks = Number(record.externalMarks);
        const passed = Number.isFinite(externalMarks) && externalMarks >= 21;
        return `<div><div><strong>${escapeHtml(record.subject)}</strong><span>${escapeHtml(record.subjectCode)} · Grade ${escapeHtml(record.grade)} · ${escapeHtml(record.totalMarks)} / ${escapeHtml(record.maximumMarks)} marks · ${escapeHtml(record.credits)} credits</span></div><b class="result-status ${passed ? 'passed' : 'failed'}">${passed ? 'PASS' : 'FAIL'}</b></div>`;
      }).join('')}</section>`).join('') || '<p class="empty-state">No results available.</p>'}</section>
      <section class="section-heading" id="backlogs-section"><div><p class="eyebrow">BACKLOGS</p><h2>Backlogs - ${(data.backlogs || []).length}</h2></div></section>
      <section class="results-list">${(data.backlogs || []).map((record) => `<div><div><strong>${escapeHtml(record.subject)}</strong><span>${escapeHtml(record.subjectCode)} · Grade ${escapeHtml(record.grade)} · Year ${escapeHtml(record.year)} · Semester ${escapeHtml(record.semester)}</span></div><b class="result-status failed">BACKLOG</b></div>`).join('') || '<p class="empty-state">No Backlogs</p>'}</section>
    `;
    document.querySelector('#backlogs-button').addEventListener('click', () => document.querySelector('#backlogs-section').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  } else if (section === 'bonafide') {
    content.innerHTML = `
      <section class="section-heading"><div><p class="eyebrow">BONAFIDE</p><h2>Bonafide certificate</h2></div></section>
      <section class="bonafide-view"><iframe id="bonafide-frame" title="Bonafide certificate" sandbox="allow-same-origin"></iframe></section>
      <button class="refresh-button" id="download-bonafide">Download PDF</button><p class="bonafide-download-error" id="bonafide-download-error" hidden role="alert"></p>
    `;
    const frame = document.querySelector('#bonafide-frame');
    frame.srcdoc = data.html;
    const fitBonafide = () => {
      const pageWidth = 794;
      const pageHeight = 1123;
      const scale = Math.min(1, frame.parentElement.clientWidth / pageWidth);
      frame.style.width = `${pageWidth}px`;
      frame.style.height = `${pageHeight}px`;
      frame.style.transform = `scale(${scale})`;
      frame.parentElement.style.height = `${pageHeight * scale}px`;
    };
    bonafideResizeObserver = new ResizeObserver(fitBonafide);
    bonafideResizeObserver.observe(frame.parentElement);
    fitBonafide();
    document.querySelector('#download-bonafide').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const errorMessage = document.querySelector('#bonafide-download-error');
      button.disabled = true;
      errorMessage.hidden = true;
      try {
        await window.downloadBonafidePdf(state.hallTicket);
      } catch (error) {
        errorMessage.textContent = error.message;
        errorMessage.hidden = false;
      } finally {
        button.disabled = false;
      }
    });
  }

  loadingPanel.hidden = true;
  errorPanel.hidden = true;
  content.hidden = false;
  refreshButton.disabled = false;
}

async function loadSection(section, date = '') {
  const requestId = ++latestRequestId;
  activeSection = section;
  activeDate = date;
  setActiveNavigation(section);

  if (!state.hallTicket) {
    location.href = 'index.html';
    return;
  }

  // Unavailable views appear at once and never reach the backend.
  if (section === 'attendance' || section === 'all-dates') {
    renderSection(section);
    return;
  }

  setLoading(true);
  try {
    const data = await window.portalApi(section, { hallTicket: state.hallTicket, date });
    if (requestId !== latestRequestId) return;
    renderSection(section, data);
  } catch (error) {
    if (requestId !== latestRequestId) return;
    loadingPanel.hidden = true;
    refreshButton.disabled = false;
    renderSectionError(error.message);
  }
}

refreshButton.addEventListener('click', () => loadSection(activeSection, activeDate));
document.querySelectorAll('[data-section]').forEach((button) => {
  button.addEventListener('click', () => loadSection(button.dataset.section));
});
document.querySelector('#retry-button').addEventListener('click', () => loadSection(activeSection, activeDate));
document.querySelector('#back-button').addEventListener('click', () => { location.href = 'index.html'; });

loadSection('attendance');
