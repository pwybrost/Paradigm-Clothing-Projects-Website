// Vercel Function entry point. vercel.json rewrites every /api/* request here,
// and the Express app in backend/ routes it (req.url keeps the original /api/... path).
import app from '../backend/app.js';

export default app;
