// Keep deployment-specific values in one small file. For local development the
// frontend and Express server share localhost:5000; a deployed static frontend
// can replace this with its deployed API origin without changing application code.
window.APP_CONFIG = {
  // The local Express server serves the frontend and API from one origin.
  // All deployed portal sections use the newer Render service.
  API_BASE_URL: ['localhost', '127.0.0.1'].includes(location.hostname)
    ? ''
    : 'https://scceattendance-2.onrender.com'
};
