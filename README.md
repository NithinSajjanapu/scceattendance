# A27 College Attendance Portal

A27 is a mobile-first, independent student interface for the public SCCE parent portal. The browser communicates only with this project's Express API; the backend keeps the SCCE session cookie and Cheerio HTML parsing on the server.

## How the application is organised

```text
frontend/
  index.html                  Hall Ticket lookup page
  attendance.html             Student dashboard and portal navigation
  css/styles.css              Shared responsive light/dark styling
  js/config.js                Deployment-specific API origin
  js/common.js                Theme and shared browser API helpers
  js/home.js                  Login validation and initial lookup
  js/attendance.js            Dashboard and portal-section rendering

backend/
  server.js                   Express middleware, route mounting, static hosting
  routes/                     Public API endpoint definitions
  controllers/                Request validation and JSON responses
  services/                   SCCE session requests and Cheerio parsers
```

The data flow is:

```text
Browser → Express API → SCCE public portal → Cheerio parser → JSON → browser UI
```

## Local development

Requires Node.js 18 or later.

```powershell
npm install --prefix backend
npm run dev
```

If your terminal is already in `backend/`, run `npm install` and `npm run dev`
there instead; do not add `--prefix backend` a second time.

Open [http://localhost:5000](http://localhost:5000). The development server serves the frontend and API together. The health check is available at `/api/health`.

If port 5000 is already in use, an earlier server instance is still running. Stop that instance before starting another one, or set a different `PORT` value in the backend environment.

## Environment configuration

The backend reads environment variables from `backend/.env`, which is intentionally ignored by Git. The relevant attendance integration settings are:

```env
PORT=5000
NODE_ENV=development
FRONTEND_ORIGIN=http://localhost:5000
COLLEGE_ATTENDANCE_URL=https://scce.ac.in/parent12
COLLEGE_ATTENDANCE_METHOD=POST
COLLEGE_HALL_TICKET_FIELD=HallticketNo
COLLEGE_REQUEST_TIMEOUT_MS=12000
COLLEGE_DAILY_REQUEST_TIMEOUT_MS=60000
```

Keep production-specific values and credentials out of source code. Never expose SCCE session cookies to the frontend.

## API endpoints

All portal requests use `POST` and accept a JSON body containing a Hall Ticket number:

```json
{ "hallTicket": "23N01A7455" }
```

| Endpoint | Purpose |
| --- | --- |
| `/api/attendance` | Attendance overview and subject records |
| `/api/profile` | Student profile information and available photo |
| `/api/daily-reports` | Available dates and a selected daily report |
| `/api/all-dates` | Complete attendance history |
| `/api/results` | Academic results using real SCCE response rows |
| `/api/forgot-hall-ticket` | Finds matching Hall Ticket Numbers from four or more name letters |
| `/api/bonafide` | Retrieves the current Bonafide certificate HTML |
| `/api/bonafide/pdf` | Downloads the current Bonafide certificate as a PDF |

`/api/daily-reports` may also include `date` in the request body. Successful section requests return `{ "success": true, "data": {} }`; attendance retains its existing response shape for frontend compatibility.

## Important business rules

- Overall attendance is calculated from total attended classes divided by total conducted classes.
- A result is **PASS** only when SCCE external marks (`EM`) are `21` or higher. Missing or non-numeric `EM` values are not marked as a pass.
- SCCE sessions, redirects, request fields, and response parsing are handled only in `backend/services/`.

## Deployment

### Backend (Render)

1. Create a Web Service with `backend` as its root directory.
2. Use `npm install` as the build command and `node server.js` as the start command. Bonafide certificates are generated natively with PDFKit; no browser runtime is required.
3. Add the environment variables from `backend/.env` in Render's secure configuration.
4. Set `NODE_ENV=production` and `FRONTEND_ORIGIN` to the deployed frontend origin.

### Frontend (Firebase Hosting)

1. Install the Firebase CLI and authenticate with the Firebase project.
2. Set `API_BASE_URL` in `frontend/js/config.js` to the deployed backend URL before deploying.
3. Run `firebase deploy --only hosting --config frontend/firebase.json` from the repository root.

This project uses only the normal public SCCE portal flow. It does not bypass CAPTCHA, authentication, authorization, or other access controls.
