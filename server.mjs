// Vercel-compatible root entrypoint.
//
// Faultline's application server lives in src/server.mjs for local development
// and CLI packaging. Vercel's zero-config Node server detection expects a root
// server entrypoint, so this adapter intentionally contains no application
// logic and preserves the same server for both hosted and local execution.

import "./src/server.mjs";
