// Vercel-compatible root entrypoint.
//
// Faultline's application server lives in src/server.mjs for local development
// and CLI packaging. Vercel's zero-config Node server detection expects a root
// server entrypoint, so this adapter keeps hosted execution pointed at the same
// application rather than introducing a second server implementation.
//
// Vercel Functions only provide writable scratch storage under /tmp. Until the
// hosted control plane gains a durable store, use /tmp explicitly so write
// attempts fail neither mysteriously nor against the read-only deployment
// filesystem. This storage is intentionally ephemeral and must not be treated
// as durable evidence persistence.

if (process.env.VERCEL && !process.env.FAULTLINE_DATA_FILE) {
  process.env.FAULTLINE_DATA_FILE = "/tmp/faultline.json";
}

// A dynamic import is deliberate. Static ESM dependencies are evaluated before
// this module body, which would make the FAULTLINE_DATA_FILE override too late.
await import("./src/server.mjs");
