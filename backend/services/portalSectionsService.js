import * as cheerio from 'cheerio';
import PDFDocument from 'pdfkit';
import { AttendanceError } from './collegeAttendanceService.js';

const BASE_URL = 'https://scce.ac.in/parent12/';
const LOGIN_URL = `${BASE_URL}index.php`;
const PROFILE_URL = `${BASE_URL}info.php`;
const DAILY_REPORT_URL = `${BASE_URL}Dailywisereport.php`;
const PROFILE_PATH = 'info.php';
const DAILY_REPORT_PATH = 'Dailywisereport.php';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const number = (value) => Number(clean(value).match(/\d+/)?.[0] || 0);
const PUBLIC_BASE_URL = 'https://scce.ac.in/parent12/';
const RESULTS_URL = 'https://scce.ac.in/result/index.php';
const configuredTimeoutMs = Number(process.env.COLLEGE_REQUEST_TIMEOUT_MS);
const timeoutMs = Math.max(60000, Number.isFinite(configuredTimeoutMs) ? configuredTimeoutMs : 0);
const configuredDailyTimeoutMs = Number(process.env.COLLEGE_DAILY_REQUEST_TIMEOUT_MS);
const dailyTimeoutMs = Math.max(timeoutMs, Number.isFinite(configuredDailyTimeoutMs) ? configuredDailyTimeoutMs : 0);

async function publicPost(url, fields) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), signal: controller.signal });
    const html = await response.text();
    if (!response.ok || !html.trim()) throw new AttendanceError('PORTAL_UNAVAILABLE', 'The college portal is temporarily unavailable. Please try again later.');
    return html;
  } catch (error) {
    if (error instanceof AttendanceError) throw error;
    if (error.name === 'AbortError') throw new AttendanceError('TIMEOUT', 'The college portal took too long to respond.', 504);
    throw new AttendanceError('PORTAL_UNAVAILABLE', 'The college portal is temporarily unavailable. Please try again later.');
  } finally { clearTimeout(timer); }
}

function tableRows($, table) {
  return $(table).find('tr').toArray().map((row) => $(row).find('td,th').toArray().map((cell) => clean($(cell).text())));
}

export async function getForgotHallTicket(name) {
  const html = await publicPost(`${PUBLIC_BASE_URL}forgothtno.php`, { name, dayatten: 'Search' });
  const $ = cheerio.load(html);
  const table = $('table').filter((_i, item) => /Hallticket\s*No/i.test(clean($(item).text()))).last();
  const rows = tableRows($, table).filter((row) => row.length >= 2 && !/^sl\s*no/i.test(row[0]));
  const matches = rows.filter((row) => /[A-Z0-9]{6,}/i.test(row[1] || '')).map((row) => ({ hallTicket: row[1], name: row[2] || '', fatherName: row[3] || '', branch: row[4] || '', year: row[5] || '' }));
  if (!matches.length) throw new AttendanceError('NOT_FOUND', 'No Hall Ticket Number was found for those letters.', 404);
  return { matches };
}

function parseResultsHtml(html, hallTicket) {
  const $ = cheerio.load(html);
  const info = {};
  $('table').each((_i, table) => tableRows($, table).forEach((row) => {
    if (row.length >= 2 && /^(Hall Ticket|Name|Father Name)\s*:/i.test(row[0])) info[row[0].replace(/\s*:\s*$/, '')] = row[1];
  }));
  const subjectTable = $('table').filter((_i, table) => /Subject\s*Code[\s\S]*Internal\s*Marks/i.test(clean($(table).text()))).first();
  const rows = tableRows($, subjectTable);
  const headers = (rows[0] || []).map((header) => header.replace(/\s+/g, '').toLowerCase());
  const index = (name) => headers.indexOf(name);
  const records = rows.slice(1).filter((row) => /^\d+$/.test(row[0] || '')).map((row) => ({
    subjectCode: row[index('subjectcode')] || '', subject: row[index('subjectname')] || '', subjectCredits: row[index('subjectcredits')] || '', grade: row[index('grade')] || '', gradePoint: row[index('gradepoint')] || '', totalGradePoint: row[index('subjectc*studentgp')] || '', internalMarks: row[index('internalmarks')] || '', externalMarks: row[index('externalmarks')] || '', totalMarks: row[index('totalmarks')] || '', maximumMarks: row[index('maxmarks')] || '', credits: row[index('credits')] || '', year: row[index('year')] || '', semester: row[index('sem')] || '', date: row[index('date')] || ''
  }));
  if (!records.length) throw new AttendanceError('NOT_FOUND', 'No results were found for this Hall Ticket Number.', 404);
  const text = clean($.root().text());
  const metric = (label) => text.match(new RegExp(`${label}\\s*:?\\s*([\\d.]+)`, 'i'))?.[1] || '';
  const backlogTable = $('table').filter((_i, table) => /BACKLOG SUBJECT/i.test(clean($(table).text()))).first();
  const backlogRows = tableRows($, backlogTable).filter((row) => /^\d+$/.test(row[0] || '')).map((row) => ({ subjectCode: row[1] || '', subject: row[2] || '', grade: row[3] || '', gradePoint: row[4] || '', totalGradePoint: row[5] || '', year: row[6] || '', semester: row[7] || '', date: row[8] || '' }));
  return { summary: { name: info.Name || '', hallTicket: info['Hall Ticket'] || hallTicket, cgpa: metric('CGPA'), percentage: metric('Percentage\\s*%'), credits: metric('Total Registered Subject Credits') }, records, backlogs: backlogRows };
}

export async function getResults(hallTicket) {
  return parseResultsHtml(await publicPost(RESULTS_URL, { htno: hallTicket, resultstu: 'Results' }), hallTicket);
}

function getBonafideImageUrls($) {
  const images = $('img[src]').map((_index, image) => new URL($(image).attr('src'), `${PUBLIC_BASE_URL}bc/`).toString()).get();
  return { logoUrl: images[0] || null, signatureUrl: images[1] || null };
}

function valueAfter(text, expression) {
  return clean(text.match(expression)?.[1] || '');
}

function parseBonafideCertificate($, hallTicket) {
  const details = clean($('p.style12').first().text());
  const values = $('p.style12').eq(1).find('strong').map((_index, item) => clean($(item).text())).get().filter(Boolean);
  const [studentName, fatherName, course, year, branch, academicYear, dateOfBirth, conduct] = values;
  return {
    title: clean($('.style11').first().text()) || 'BONAFIDE CERTIFICATE',
    admissionNumber: valueAfter(details, /Admission\s*No\s*:\s*(.*?)(?=\s*Date\s+of\s+Admission\s*:|$)/i),
    dateOfAdmission: valueAfter(details, /Date\s+of\s+Admission\s*:\s*(.*?)(?=\s+Date\s*:|\s+Hall\s+Ticket|$)/i),
    certificateDate: valueAfter(details, /(?:^|\s)Date\s*:\s*(.*?)(?=\s+Hall\s+Ticket|$)/i),
    hallTicket: valueAfter(details, /Hall\s*Ticket\s*No\s*:\s*(.*)$/i) || hallTicket,
    studentName, fatherName, course, year, branch, academicYear, dateOfBirth, conduct
  };
}

function createBonafidePreviewHtml($) {
  $('script, noscript').remove();
  $('*').each((_i, element) => Object.keys(element.attribs || {}).filter((name) => /^on/i.test(name)).forEach((name) => $(element).removeAttr(name)));
  $('img[src]').each((_i, image) => $(image).attr('src', new URL($(image).attr('src'), `${PUBLIC_BASE_URL}bc/`).toString()));
  $('head').append(`<style id="a27-certificate-layout">
    @page { size: A4 portrait; margin: 0; }
    * { box-sizing: border-box; }
    html, body { width: 210mm; min-height: 297mm; margin: 0; overflow: hidden; background: #fff; }
    body { padding: 10mm; }
    center { display: block; width: 100%; }
    center > table, center > table > tbody > tr > td > table { width: 100% !important; max-width: 100% !important; height: auto !important; }
    img { max-width: 100% !important; height: auto !important; }
    .style12 { font-size: 16px !important; line-height: 1.65 !important; }
  </style>`);
  return $.html();
}

async function getBonafideDocument(hallTicket) {
  const html = await publicPost(`${PUBLIC_BASE_URL}bc/bc.php`, { HallticketNo: hallTicket, submit: 'Login' });
  if (/certificate disabled|contact\s+ao/i.test(html)) throw new AttendanceError('CERTIFICATE_UNAVAILABLE', 'A Bonafide certificate is not available for this Hall Ticket Number.', 404);
  if (!/BONAFIDE CERTIFICATE/i.test(html)) throw new AttendanceError('UNREADABLE_RESPONSE', 'Unable to read the Bonafide certificate right now.');
  const $ = cheerio.load(html);
  const images = getBonafideImageUrls($);
  return { certificate: parseBonafideCertificate($, hallTicket), images, html: createBonafidePreviewHtml($) };
}

export async function getBonafide(hallTicket) {
  const { html } = await getBonafideDocument(hallTicket);
  return { html };
}

async function loadBonafideImage(source) {
  if (!source) return null;
  try {
    const url = new URL(source);
    const publicBase = new URL(PUBLIC_BASE_URL);
    if (url.origin !== publicBase.origin || !url.pathname.startsWith('/parent12/bc/')) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
    } finally { clearTimeout(timer); }
  } catch (error) {
    console.warn('BONAFIDE_IMAGE_UNAVAILABLE', error.name);
    return null;
  }
}

function drawImageContain(doc, image, x, y, maxWidth, maxHeight) {
  if (!image) return 0;
  const dimensions = doc.openImage(image);
  const scale = Math.min(maxWidth / dimensions.width, maxHeight / dimensions.height);
  const width = dimensions.width * scale;
  const height = dimensions.height * scale;
  doc.image(image, x + (maxWidth - width) / 2, y, { width, height });
  return height;
}

function certificateBody(certificate) {
  return `This is to certify that ${certificate.studentName || ''} S/o.D/o ${certificate.fatherName || ''} was a bonafide student of this college studying ${certificate.course || ''} Course ${certificate.year || ''} & ${certificate.branch || ''} branch for the academic year ${certificate.academicYear || ''} His /Her Date of Birth as per our records is ${certificate.dateOfBirth || ''} His /Her conduct is ${certificate.conduct || ''}`.replace(/\s+/g, ' ').trim();
}

async function renderBonafidePdf(certificate, images) {
  const [logo, signature] = await Promise.all([loadBonafideImage(images.logoUrl), loadBonafideImage(images.signatureUrl)]);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: certificate.title } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.once('error', reject);
    doc.once('end', () => resolve(Buffer.concat(chunks)));
    try {
      const { width: pageWidth } = doc.page;
      const border = 28;
      const borderHeight = 390;
      const headerX = border + 28;
      const headerWidth = pageWidth - (headerX * 2);
      const textX = border + 7;
      const textWidth = pageWidth - (textX * 2);
      doc.lineWidth(1.5).roundedRect(border, border, pageWidth - (border * 2), borderHeight, 15).stroke();
      const logoHeight = drawImageContain(doc, logo, headerX, 40, headerWidth, 58);
      const titleY = 46 + logoHeight;
      doc.font('Times-Bold').fontSize(17).text(certificate.title, headerX, titleY, { width: headerWidth, align: 'center', underline: true });
      const detailsY = titleY + 36;
      doc.font('Times-Italic').fontSize(12)
        .text(`Admission No : ${certificate.admissionNumber} & Date of Admission : ${certificate.dateOfAdmission}                         Date:${certificate.certificateDate}`, textX, detailsY, { width: textWidth })
        .text(`Hall Ticket No : ${certificate.hallTicket}`, textX, detailsY + 23, { width: textWidth });
      doc.font('Times-Italic').fontSize(14).text(certificateBody(certificate), textX, detailsY + 73, { width: textWidth, align: 'justify', lineGap: 7 });
      const signatureY = 300;
      drawImageContain(doc, signature, headerX, signatureY, headerWidth, 62);
      const labelY = 373;
      doc.font('Times-Italic').fontSize(14).text('Clerk', textX, labelY, { width: textWidth / 3, align: 'center' });
      doc.text('AO', textX + (textWidth / 3), labelY, { width: textWidth / 3, align: 'center' });
      doc.text('Principal', textX + (textWidth * 2 / 3), labelY, { width: textWidth / 3, align: 'center' });
      doc.end();
    } catch (error) { reject(error); }
  });
}

export async function getBonafidePdf(hallTicket) {
  try {
    const { certificate, images } = await getBonafideDocument(hallTicket);
    return await renderBonafidePdf(certificate, images);
  } catch (error) {
    if (error instanceof AttendanceError) throw error;
    console.error('BONAFIDE_PDF_FAILED', error.name);
    throw new AttendanceError('PDF_ERROR', 'Unable to create the Bonafide PDF right now.');
  }
}

/**
 * Establish a public SCCE PHP session once, authenticate it with the supplied
 * Hall Ticket number, then give callers a request helper bound to that cookie.
 * Cookies never leave the server or appear in the browser response.
 */
function mergeSessionCookies(currentCookie, headers) {
  const setCookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  const cookies = new Map(
    String(currentCookie || '').split(/;\s*/).filter(Boolean).map((item) => {
      const [name] = item.split('=', 1);
      return [name, item];
    })
  );

  setCookies.forEach((header) => {
    const cookie = header.split(';', 1)[0];
    const [name] = cookie.split('=', 1);
    if (name) cookies.set(name, cookie);
  });

  return [...cookies.values()].join('; ');
}

async function withStudentSession(hallTicket, task, requestTimeoutMs = timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    // The bare /parent12/ directory currently returns a server error. The
    // profile page is the stable public entry point that creates PHPSESSID.
    const start = await fetch(PROFILE_URL, {
      redirect: 'manual',
      signal: controller.signal
    });
    let cookie = mergeSessionCookies('', start.headers);

    if (!cookie) {
      throw new AttendanceError(
        'PORTAL_UNAVAILABLE',
        'Attendance portal is temporarily unavailable.'
      );
    }

    const login = await fetch(LOGIN_URL, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie
      },
      body: new URLSearchParams({
        HallticketNo: hallTicket,
        submit: 'Login'
      })
    });
    cookie = mergeSessionCookies(cookie, login.headers);
    const location = login.headers.get('location');

    if (!location) {
      throw new AttendanceError('NOT_FOUND', 'No student record found.', 404);
    }

    // Visit the redirect once so the session is in the same state as SCCE's UI.
    const redirectResponse = await fetch(new URL(location, LOGIN_URL), {
      signal: controller.signal,
      headers: {
        cookie,
        referer: LOGIN_URL
      }
    });
    cookie = mergeSessionCookies(cookie, redirectResponse.headers);

    const request = async (path, options = {}) => {
      // Spread custom options first, then merge headers so a POST cannot drop
      // the session cookie that SCCE requires for every protected report page.
      const response = await fetch(`${BASE_URL}${path}`, {
        signal: controller.signal,
        ...options,
        headers: {
          cookie,
          referer: LOGIN_URL,
          ...(options.headers || {})
        }
      });

      return { response, html: await response.text() };
    };

    return await task(request);
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

function findStudentPhoto($) {
  const images = $('img[src]').toArray().map((image) => {
    const element = $(image);
    return {
      source: element.attr('src'),
      context: [
        element.attr('alt'), element.attr('id'), element.attr('class'),
        element.closest('td, tr, div').text(), element.attr('width'), element.attr('height')
      ].filter(Boolean).join(' ')
    };
  }).filter(({ source }) => source && !/(logo|banner|header|college|scce|sree|chaitanya)/i.test(source));

  // SCCE sometimes uses a Hall-Ticket filename with no useful image metadata.
  // Prefer explicitly identified photos, then use the first non-brand asset.
  return images.find(({ source, context }) =>
    /(student|photo|profile|passport|upload|hallticket|htno)/i.test(`${source} ${context}`)
  )?.source || images[0]?.source || null;
}

/** Read the real profile table and use a photo only when SCCE identifies it as student data. */
export async function getProfile(hallTicket) {
  return withStudentSession(hallTicket, async (request) => {
    const { response, html } = await request(PROFILE_PATH);

    if (!response.ok) {
      throw new AttendanceError('PORTAL_UNAVAILABLE', 'Unable to load profile right now.');
    }

    const $ = cheerio.load(html);
    const fields = {};

    $('tr').each((_index, row) => {
      const cells = $(row).find('th,td');
      if (cells.length < 2) return;

      const label = clean(cells.eq(0).text()).replace(/:$/, '');
      const value = clean(cells.eq(1).text()).replace(/^:/, '');

      if (label && value) {
        fields[label] = value;
      }
    });

    const photoSource = findStudentPhoto($);

    return {
      fields,
      photoUrl: photoSource ? new URL(photoSource, BASE_URL).toString() : null
    };
  });
}

/** Parse SCCE's all-dates rows and always present them from oldest to newest. */
function parseHistory(html) {
  const $ = cheerio.load(html);
  const records = [];

  $('tr').each((_index, row) => {
    const cells = $(row)
      .find('td')
      .map((_cellIndex, cell) => clean($(cell).text()))
      .get();

    if (cells.length >= 5 && /^\d+$/.test(cells[0])) {
      records.push({
        date: cells[1],
        subject: cells[2],
        attended: number(cells[3]),
        conducted: number(cells[4])
      });
    }
  });

  return records.sort((first, second) => {
    const parseDate = (value) => {
      const [day, month, year] = value.split('-').map(Number);
      return new Date(year, month - 1, day).getTime();
    };

    return parseDate(first.date) - parseDate(second.date);
  });
}

/** Parse both daily table variants currently returned by SCCE. */
function parseDailyReport(html, selectedDate) {
  const $ = cheerio.load(html);
  const records = [];

  $('tr').each((_index, row) => {
    const cells = $(row)
      .find('td')
      .map((_cellIndex, cell) => clean($(cell).text()))
      .get();

    // Standard format: Sno / Hour / Sub / Atnd / Cnctd.
    if (cells.length >= 5 && /^\d+$/.test(cells[0]) && /^\d+$/.test(cells[1])) {
      records.push({
        date: selectedDate,
        hour: cells[1],
        subject: cells[2],
        attended: number(cells[3]),
        conducted: number(cells[4])
      });
      return;
    }

    // Compatibility format: Sno / Sub / Atnd / Cnctd.
    if (cells.length >= 4 && /^\d+$/.test(cells[0])) {
      records.push({
        date: selectedDate,
        hour: null,
        subject: cells[1],
        attended: number(cells[2]),
        conducted: number(cells[3])
      });
    }
  });

  return records;
}

export async function getAllDates(hallTicket) {
  return withStudentSession(hallTicket, async (request) => {
    const { response, html } = await request('Dailywise1.php');

    if (!response.ok) {
      throw new AttendanceError(
        'PORTAL_UNAVAILABLE',
        'Unable to load attendance history right now.'
      );
    }

    return { records: parseHistory(html) };
  });
}

export async function getDailyReports(hallTicket, selectedDate = '') {
  return withStudentSession(hallTicket, async (request) => {
    let result = await request(DAILY_REPORT_PATH);
    const $ = cheerio.load(result.html);
    const availableDates = $('select[name="date"] option')
      .map((_index, option) => ({
        value: $(option).attr('value') || clean($(option).text()),
        label: clean($(option).text())
      }))
      .get()
      .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.value));

    if (!selectedDate) {
      return { availableDates, selectedDate: '', records: [] };
    }

    // The portal expects a POST plus its `dayatten` submit value for a date.
    result = await request(DAILY_REPORT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        date: selectedDate,
        dayatten: 'Submit'
      })
    });

    return {
      availableDates,
      selectedDate,
      records: parseDailyReport(result.html, selectedDate)
    };
  }, dailyTimeoutMs);
}
