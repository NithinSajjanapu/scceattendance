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

/**
 * SCCE creates a PHP session before it accepts a Hall Ticket request. Keep the
 * cookie server-side, submit the ticket, and follow the redirect with that same
 * cookie before parsing the returned attendance table.
 */
export async function lookupAttendance(hallTicket) {
  const url = process.env.COLLEGE_ATTENDANCE_URL;

  if (!url) {
    throw new AttendanceError(
      'INTEGRATION_NOT_CONFIGURED',
      'Live attendance lookup has not been configured yet. Please contact the portal administrator.',
      503
    );
  }

  const method = (process.env.COLLEGE_ATTENDANCE_METHOD || 'POST').toUpperCase();
  const field = process.env.COLLEGE_HALL_TICKET_FIELD || 'hallTicket';
  const params = new URLSearchParams({
    ...parseStaticFields(),
    [field]: hallTicket
  });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(process.env.COLLEGE_REQUEST_TIMEOUT_MS || 12000)
  );

  try {
    // Open the portal first so PHP sends the session cookie required by login.
    const sessionUrl = new URL('./', url).toString();
    const sessionResponse = await fetch(sessionUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal
    });
    const setCookie = sessionResponse.headers.get('set-cookie');

    if (!setCookie) {
      throw new AttendanceError(
        'PORTAL_UNAVAILABLE',
        'Unable to establish a session with the attendance portal.'
      );
    }

    const cookie = setCookie.split(';')[0];
    const response = await fetch(url, {
      method,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie
      },
      body: method === 'POST' ? params : undefined
    });
    const html = await response.text();

    // Follow the PHP redirect manually so the same session reaches the report.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');

      if (!location) {
        throw new AttendanceError(
          'PORTAL_UNAVAILABLE',
          'Attendance portal returned an invalid redirect.'
        );
      }

      const redirectUrl = new URL(location, url).toString();
      const attendanceResponse = await fetch(redirectUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          cookie,
          referer: new URL('./', url).toString()
        }
      });
      const attendanceHtml = await attendanceResponse.text();

      if (!attendanceResponse.ok && !attendanceHtml.includes('Attendance Report')) {
        throw new AttendanceError(
          'PORTAL_UNAVAILABLE',
          'Attendance portal is temporarily unavailable. Please try again later.'
        );
      }

      if (/no record|not found|invalid hall|does not exist/i.test(attendanceHtml)) {
        throw new AttendanceError('NOT_FOUND', 'No attendance record found.', 404);
      }

      return parseAttendanceHtml(attendanceHtml, hallTicket);
    }

    if (!response.ok) {
      throw new AttendanceError(
        'PORTAL_UNAVAILABLE',
        'Attendance portal is temporarily unavailable. Please try again later.'
      );
    }

    return parseAttendanceHtml(html, hallTicket);
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
