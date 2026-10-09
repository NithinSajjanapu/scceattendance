import * as cheerio from 'cheerio';

// Service errors carry a safe HTTP status and message that controllers can
// return to the browser without exposing low-level upstream implementation data.
export class AttendanceError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

function percent(value, attended, conducted) {
  const rawValue = String(value ?? '').replace('%', '').trim();
  const parsed = rawValue === '' ? Number.NaN : Number(rawValue);

  return Number.isFinite(parsed)
    ? Math.round(parsed)
    : conducted
      ? Math.round((attended / conducted) * 100)
      : 0;
}

function parseStaticFields() {
  try {
    return JSON.parse(process.env.COLLEGE_STATIC_FIELDS || '{}');
  } catch {
    throw new AttendanceError(
      'CONFIGURATION_ERROR',
      'Attendance integration configuration is invalid.',
      500
    );
  }
}

/**
 * Find a value next to a known label across the table and form layouts used by
 * public portals. Cheerio parses response HTML with familiar CSS selectors.
 */
function findValue($, labels) {
  const normalisedLabels = labels.map((label) => label.toLowerCase());
  let value = '';

  // The most common pattern is: <td>Student Name</td><td>Jane Doe</td>.
  $('tr').each((_index, row) => {
    if (value) return;

    const cells = $(row).find('th, td');
    cells.each((cellIndex, cell) => {
      if (value) return;

      const label = clean($(cell).text()).replace(/[:\-]$/, '').toLowerCase();
      if (normalisedLabels.includes(label)) {
        value = clean(cells.eq(cellIndex + 1).text());
      }
    });
  });

  if (value) return value;

  // Some portal templates keep field values in an element ID or class.
  $('[id], [name], [class]').each((_index, element) => {
    if (value) return;

    const attributes = [
      $(element).attr('id'),
      $(element).attr('name'),
      $(element).attr('class')
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z]/g, '');
    const isStudentName = /studentname|studentfullname|sname|nameofthe|nameofstudent/.test(attributes);

    if (isStudentName) {
      value = clean($(element).val() || $(element).text());
    }
  });

  if (value) return value;

  // As a final fallback, support a single text element such as "Name: Jane Doe".
  $('[class], p, div, label').each((_index, element) => {
    if (value) return;

    const text = clean($(element).clone().children().remove().end().text());
    const label = labels.find((item) => new RegExp(`^${item}\\s*[:\\-]\\s*`, 'i').test(text));

    if (label) {
      value = clean(text.replace(new RegExp(`^${label}\\s*[:\\-]\\s*`, 'i'), ''));
    }
  });

  return value;
}

/**
 * SCCE prints the hall ticket, name, and year as nearby text instead of using a
 * separate labelled name cell. Extract that stable sequence as a fallback.
 */
function findStudentNameFromPortalText($, hallTicket) {
  const pageText = clean($.root().text());
  const escapedTicket = hallTicket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = pageText.match(new RegExp(
    `${escapedTicket}\\s+(.+?)\\s+\\d+(?:st|nd|rd|th)\\s+Year\\b`,
    'i'
  ));

  return match ? clean(match[1]) : '';
}

function findYearFromPortalText($, hallTicket) {
  const pageText = clean($.root().text());
  const escapedTicket = hallTicket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = pageText.match(new RegExp(
    `${escapedTicket}\\s+.+?\\s+(\\d+(?:st|nd|rd|th)\\s+Year)\\b`,
    'i'
  ));

  return match ? clean(match[1]) : '';
}

function columnIndex(headers, terms) {
  return headers.findIndex((header) => terms.some((term) => header.includes(term)));
}

/**
 * Convert SCCE attendance table HTML into the stable JSON shape consumed by
 * the dashboard. Header aliases keep this parser compatible with portal labels
 * such as Sub/Atnd/Cndt as well as their longer equivalents.
 */
export function parseAttendanceHtml(html, hallTicket) {
  const $ = cheerio.load(html);
  let records = [];

  $('table').each((_tableIndex, table) => {
    if (records.length) return;

    const rows = $(table).find('tr');
    const headers = $(rows[0])
      .find('th, td')
      .map((_index, cell) => clean($(cell).text()).toLowerCase())
      .get();
    const subjectIndex = columnIndex(headers, ['subject', 'sub', 'course', 'paper']);
    const attendedIndex = columnIndex(headers, ['attended', 'atnd', 'present']);
    const conductedIndex = columnIndex(headers, ['conducted', 'cndt', 'held', 'total classes']);
    const percentageIndex = columnIndex(headers, ['percentage', '%']);

    if (subjectIndex < 0 || attendedIndex < 0 || conductedIndex < 0) {
      return;
    }

    records = rows
      .slice(1)
      .map((_index, row) => {
        const cells = $(row)
          .find('td')
          .map((_cellIndex, cell) => clean($(cell).text()))
          .get();

        if (cells.length < 4 || /^total/i.test(clean($(row).text()))) {
          return null;
        }

        const name = cells[subjectIndex];
        const attended = Number((cells[attendedIndex] || '').match(/\d+/)?.[0]);
        const conducted = Number((cells[conductedIndex] || '').match(/\d+/)?.[0]);

        if (!name || !Number.isFinite(attended) || !Number.isFinite(conducted)) {
          return null;
        }

        return {
          name,
          attended,
          conducted,
          percentage: percent(cells[percentageIndex] || '', attended, conducted)
        };
      })
      .get()
      .filter(Boolean);
  });

  if (!records.length) {
    throw new AttendanceError(
      'UNREADABLE_RESPONSE',
      'Unable to read attendance data right now.'
    );
  }

  const attended = records.reduce((sum, item) => sum + item.attended, 0);
  const conducted = records.reduce((sum, item) => sum + item.conducted, 0);

  return {
    student: {
      hallTicket,
      name: findValue($, ['student name', 'name'])
        || findStudentNameFromPortalText($, hallTicket)
        || 'Student',
      year: findValue($, ['year', 'class'])
        || findYearFromPortalText($, hallTicket)
        || 'Not provided'
    },
    subjects: records,
    overall: {
      attended,
      conducted,
      percentage: percent('', attended, conducted)
    }
  };
}

const PORTAL_BASE_URL = 'https://scce.ac.in/parent12/';

function mergeCookies(cookieHeader, headers) {
  const setCookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  const cookies = new Map(String(cookieHeader || '').split(/;\s*/).filter(Boolean).map((item) => {
    const [name] = item.split('=', 1);
    return [name, item];
  }));
  setCookies.forEach((header) => {
    const cookie = header.split(';', 1)[0];
    const [name] = cookie.split('=', 1);
    if (name) cookies.set(name, cookie);
  });
  return [...cookies.values()].join('; ');
}

function readProfileValue($, fieldLabel) {
  let value = '';
  const target = fieldLabel.toLowerCase().replace(/[^a-z]/g, '');

  $('body *').each((_index, element) => {
    if (value) return;
    const ownText = clean($(element).contents().filter((_i, node) => node.type === 'text').text())
      .replace(/^[:\s]+|[:\s]+$/g, '');
    if (ownText.toLowerCase().replace(/[^a-z]/g, '') !== target) return;

    const siblings = $(element).parent().children().toArray();
    const position = siblings.indexOf(element);
    for (const sibling of siblings.slice(position + 1)) {
      const siblingText = clean($(sibling).text()).replace(/^[:\s]+/, '');
      if (siblingText) {
        value = siblingText;
        return;
      }
    }
  });

  if (value) return value;
  const pageText = clean($('body').text());
  const nextLabel = fieldLabel.toLowerCase() === 'student name' ? 'Father Name' : 'Student Name';
  const match = pageText.match(new RegExp(`${fieldLabel}\\s*:?\\s*(.+?)\\s*(?=${nextLabel}|$)`, 'i'));
  return match ? clean(match[1]).replace(/^:/, '').trim() : '';
}

function parsePortalProfile(html, hallTicket) {
  const $ = cheerio.load(html);
  return {
    hallTicket: readProfileValue($, 'Hallticket No') || hallTicket,
    name: readProfileValue($, 'Student Name') || 'Student'
  };
}

function collectSubmitForm($, hallTicket) {
  const $form = $('form').filter((_index, form) => $(form).find('input[type="submit"], button[type="submit"], button:not([type])').length > 0).first();
  if (!$form.length) throw new AttendanceError('UNREADABLE_RESPONSE', 'Unable to read the attendance form.');

  const params = new URLSearchParams();
  $form.find('input[name], select[name], textarea[name]').each((_index, element) => {
    const $element = $(element);
    const name = $element.attr('name');
    const type = ($element.attr('type') || '').toLowerCase();
    if (!name || ['submit', 'button', 'image', 'file'].includes(type)) return;
    if (['checkbox', 'radio'].includes(type) && !$element.is(':checked')) return;
    const value = type === 'checkbox' || type === 'radio'
      ? ($element.attr('value') || 'on')
      : ($element.val() ?? '');
    params.append(name, /hall.?ticket|htno/i.test(name) ? hallTicket : String(value));
  });

  const $submit = $form.find('input[type="submit"], button[type="submit"], button:not([type])').first();
  if ($submit.length && $submit.attr('name')) {
    params.append($submit.attr('name'), $submit.attr('value') || clean($submit.text()) || 'Submit');
  }

  return {
    url: new URL($form.attr('action') || 'Dailywise1.php', PORTAL_BASE_URL).toString(),
    method: ($form.attr('method') || 'GET').toUpperCase(),
    params
  };
}

function parseOverallAttendance(html) {
  const $ = cheerio.load(html);
  let overall = null;
  $('tr').each((_index, row) => {
    if (overall) return;
    const cells = $(row).find('th, td').map((_cellIndex, cell) => clean($(cell).text())).get();
    if (!cells.length || !/^total\b/i.test(cells[0])) return;
    const attended = Number(cells[1]?.match(/[\d,]+/)?.[0]?.replace(/,/g, ''));
    const conducted = Number(cells[2]?.match(/[\d,]+/)?.[0]?.replace(/,/g, ''));
    const percentage = Number(cells[3]?.match(/[\d.]+/)?.[0]);
    if ([attended, conducted, percentage].every(Number.isFinite)) {
      overall = { attended, conducted, percentage: Math.round(percentage) };
    }
  });
  if (!overall) throw new AttendanceError('UNREADABLE_RESPONSE', 'Unable to read overall attendance totals.');
  return overall;
}

function parseAttendanceSubjects(html) {
  const $ = cheerio.load(html);
  const subjects = new Map();
  $('tr').each((_index, row) => {
    const cells = $(row).find('td, th').map((_cellIndex, cell) => clean($(cell).text())).get();
    if (cells.length < 5 || !/^\d+$/.test(cells[0]) || /^total\b/i.test(cells[0])) return;
    const name = cells[1];
    const attended = Number(cells[2]?.match(/[\d,]+/)?.[0]?.replace(/,/g, ''));
    const conducted = Number(cells[3]?.match(/[\d,]+/)?.[0]?.replace(/,/g, ''));
    if (!name || !Number.isFinite(attended) || !Number.isFinite(conducted)) return;
    const current = subjects.get(name) || { name, attended: 0, conducted: 0 };
    current.attended += attended;
    current.conducted += conducted;
    subjects.set(name, current);
  });
  return [...subjects.values()].map((subject) => ({
    ...subject,
    percentage: percent('', subject.attended, subject.conducted)
  }));
}

/**
 * SCCE creates a PHP session before it accepts a Hall Ticket request. Keep the
 * cookie server-side, submit the ticket, and follow the redirect with that same
 * cookie before parsing the returned attendance table.
 */
export async function lookupAttendance(hallTicket) {
  const controller = new AbortController();
  const configuredTimeout = Number(process.env.COLLEGE_REQUEST_TIMEOUT_MS);
  const timeoutMs = Math.max(60000, Number.isFinite(configuredTimeout) ? configuredTimeout : 0);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const profileUrl = new URL('info.php', PORTAL_BASE_URL).toString();
    const loginUrl = new URL('index.php', PORTAL_BASE_URL).toString();
    const sessionResponse = await fetch(profileUrl, { redirect: 'manual', signal: controller.signal });
    let cookie = mergeCookies('', sessionResponse.headers);
    if (!cookie) {
      console.warn('[attendance] Portal session bootstrap returned no cookie', {
        status: sessionResponse.status,
        responseUrl: sessionResponse.url,
        contentType: sessionResponse.headers.get('content-type'),
        server: sessionResponse.headers.get('server'),
        cfRay: sessionResponse.headers.get('cf-ray')
      });
      throw new AttendanceError(
        'PORTAL_UNAVAILABLE',
        'Unable to establish a session with the attendance portal.'
      );
    }

    const login = await fetch(loginUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie
      },
      body: new URLSearchParams({ HallticketNo: hallTicket, submit: 'Login' })
    });
    cookie = mergeCookies(cookie, login.headers);
    const redirectLocation = login.headers.get('location');
    if (!redirectLocation) throw new AttendanceError('NOT_FOUND', 'No student record found.', 404);
    const landingResponse = await fetch(new URL(redirectLocation, loginUrl), {
      signal: controller.signal,
      headers: { cookie, referer: loginUrl }
    });
    cookie = mergeCookies(cookie, landingResponse.headers);

    const request = async (url, options = {}) => {
      const response = await fetch(url, {
        signal: controller.signal,
        ...options,
        headers: { cookie, referer: loginUrl, ...(options.headers || {}) }
      });
      return { response, html: await response.text() };
    };

    const profileResult = await request(profileUrl);
    const attendanceUrl = new URL('Dailywise1.php', PORTAL_BASE_URL).toString();
    const formResult = await request(attendanceUrl);
    if (!profileResult.response.ok || !formResult.response.ok) {
      throw new AttendanceError('PORTAL_UNAVAILABLE', 'Attendance portal is temporarily unavailable.');
    }
    const $formPage = cheerio.load(formResult.html);
    const form = collectSubmitForm($formPage, hallTicket);
    const submitOptions = form.method === 'POST'
      ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.params }
      : { method: 'GET' };
    const submitUrl = form.method === 'POST'
      ? form.url
      : `${form.url}${form.url.includes('?') ? '&' : '?'}${form.params.toString()}`;
    const report = await request(submitUrl, submitOptions);
    if (!report.response.ok) throw new AttendanceError('PORTAL_UNAVAILABLE', 'Attendance portal is temporarily unavailable.');

    return {
      student: parsePortalProfile(profileResult.html, hallTicket),
      subjects: parseAttendanceSubjects(report.html),
      totalSubjects: null,
      overall: parseOverallAttendance(report.html)
    };
  } catch (error) {
    if (error instanceof AttendanceError) throw error;

    if (error.name === 'AbortError') {
      throw new AttendanceError(
        'TIMEOUT',
        'The attendance portal took too long to respond.',
        504
      );
    }

    throw new AttendanceError(
      'PORTAL_UNAVAILABLE',
      'Attendance portal is temporarily unavailable. Please try again later.'
    );
  } finally {
    clearTimeout(timeout);
  }
}
