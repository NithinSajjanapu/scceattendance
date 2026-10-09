import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import attendanceRouter from './routes/attendanceRoutes.js';
import portalSectionsRouter from './routes/portalSectionsRoutes.js';

const app = express();
app.set("trust proxy", 1);
const port = Number(process.env.PORT || 5000);
const isProduction = process.env.NODE_ENV === 'production';
const frontendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend');

// Security, request parsing, and rate limiting apply before any public API route.
// The rate limiter protects the public lookup endpoint without logging student data.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN?.split(',') || true,
  methods: ['GET', 'POST']
}));
app.use(express.json({ limit: '10kb' }));
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false
}));

// Routes only define API paths. Controllers handle HTTP concerns and services
// contain the SCCE session, request, and HTML-parsing implementation.
app.use('/api/attendance', attendanceRouter);
app.use('/api', portalSectionsRouter);
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// In development Express serves the static frontend. Production may serve the
// frontend independently (for example from Vercel) and keep this API on Render.
if (!isProduction || process.env.SERVE_FRONTEND === 'true') {
  app.use(express.static(frontendDirectory));
}

app.use((err, _req, res, _next) => {
  // Keep useful server-side diagnostics without exposing technical details in JSON.
  console.error('Unhandled application error:', err.name);
  res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    message: 'Something went wrong. Please try again.'
  });
});

app.listen(port, () => {
  console.log(`Attendance API listening on port ${port}`);
});
