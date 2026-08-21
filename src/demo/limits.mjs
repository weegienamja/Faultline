// Abuse controls for the public demo.
//
// HONEST SCOPE, stated up front because the alternative is a security control
// that only exists in a comment:
//
//   A Vercel Function is horizontally scaled and stateless. This limiter is
//   per INSTANCE. It bounds what one warm instance will do, which is what
//   stops a single visitor hammering the endpoint from a browser, and it is
//   NOT a globally reliable quota. No durable distributed store is provisioned
//   for this deployment, so nothing here pretends to be one. `describe()`
//   reports that limitation to the interface and to /api/capabilities rather
//   than leaving an operator to assume a guarantee that does not exist.
//
// What DOES hold globally, regardless of instance count, is the boundary in
// policy.mjs: a fixed allowlist, ports 80/443 only, hostname-only targets and
// full address validation. The blast radius of exhausting this limiter is
// therefore "more requests to github.com", not "a scanner".
//
// Three independent bounds apply:
//
//   per-client    a token bucket keyed on the forwarded client address
//   per-instance  a global bucket, so many clients cannot sum to abuse
//   concurrency   a hard ceiling on diagnostics running at once, because each
//                 one holds sockets open for seconds

const MINUTE = 60_000;

export const DEMO_LIMITS = Object.freeze({
  perClientPerMinute: 10,
  /**
   * How many statically REFUSED targets one client may bounce off per minute.
   *
   * Wider than the live budget because a refusal costs no network activity, and
   * still bounded because "unbounded" is not a thing this router offers.
   */
  refusedPerClientPerMinute: 40,
  perInstancePerMinute: 60,
  maxConcurrent: 3,
  /** Whole-diagnostic budget. A Function that runs longer is killed anyway. */
  requestBudgetMs: 25_000
});

/** Read one bounded integer override. An absurd value is clamped, not honoured. */
function bounded(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), min), max);
}

/**
 * Deployment-tunable limits.
 *
 * A request that is REFUSED BY STATIC POLICY - a bad scheme, a port that is not
 * 80/443, a literal address, a hostname that is not on the allowlist - is
 * refunded against the live budget and charged to a separate, wider bucket
 * instead. It resolved nothing, connected to nothing and cost this deployment
 * a regex, and the policy it bounced off is already published in full at
 * /api/demo/capabilities, so charging it bought no secrecy. What it did buy was
 * the demo locking out any visitor who typed three hostnames to find out what
 * the allowlist was - the ten-request budget spent on error messages before a
 * single diagnostic ran.
 *
 * A refusal that happens AFTER resolution (an address that validates as
 * private, a redirect to somewhere it may not follow) is NOT refunded: that one
 * really did make this deployment do work on the network.
 */
export function readLimits(env = process.env) {
  return Object.freeze({
    perClientPerMinute: bounded(env.FAULTLINE_DEMO_RATE_PER_MIN, DEMO_LIMITS.perClientPerMinute, 1, 120),
    refusedPerClientPerMinute: bounded(
      env.FAULTLINE_DEMO_REFUSED_RATE_PER_MIN,
      DEMO_LIMITS.refusedPerClientPerMinute,
      1,
      600
    ),
    perInstancePerMinute: bounded(env.FAULTLINE_DEMO_RATE_INSTANCE_PER_MIN, DEMO_LIMITS.perInstancePerMinute, 1, 600),
    maxConcurrent: bounded(env.FAULTLINE_DEMO_MAX_CONCURRENT, DEMO_LIMITS.maxConcurrent, 1, 16),
    requestBudgetMs: bounded(env.FAULTLINE_DEMO_REQUEST_BUDGET_MS, DEMO_LIMITS.requestBudgetMs, 5_000, 60_000)
  });
}

export class RateLimitError extends Error {
  constructor(message, retryAfterSeconds) {
    super(message);
    this.name = "RateLimitError";
    this.statusCode = 429;
    this.code = "DEMO_RATE_LIMIT";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The client address, as far as it can be known behind a proxy.
 *
 * The LEFTMOST entry of x-forwarded-for is caller-controlled and therefore
 * useless for rate limiting - a spoofed header would mint a fresh bucket per
 * request. Vercel appends the real peer, so the RIGHTMOST entry is the one
 * this deployment can rely on. `x-real-ip` is set by the platform and is
 * preferred when present.
 */
export function clientKey(req) {
  const real = String(req?.headers?.["x-real-ip"] || "").trim();
  if (real) return real.slice(0, 64);

  const forwarded = String(req?.headers?.["x-forwarded-for"] || "");
  const hops = forwarded.split(",").map(entry => entry.trim()).filter(Boolean);
  if (hops.length) return hops[hops.length - 1].slice(0, 64);

  return String(req?.socket?.remoteAddress || "unknown").slice(0, 64);
}

export function createDemoLimiter({ limits = readLimits(), now = () => Date.now() } = {}) {
  /** key -> { windowStartedAt, count }. Bounded by the sweep below. */
  const clients = new Map();
  let instanceWindowStartedAt = now();
  let instanceCount = 0;
  let inFlight = 0;

  function sweep(at) {
    // Keeps the map from growing without bound on a long-lived instance.
    if (clients.size < 2_000) return;
    for (const [key, entry] of clients) {
      if (at - entry.windowStartedAt >= MINUTE) clients.delete(key);
    }
  }

  function consumeWindow(entry, at, max, label) {
    if (at - entry.windowStartedAt >= MINUTE) {
      entry.windowStartedAt = at;
      entry.count = 0;
    }
    if (entry.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((MINUTE - (at - entry.windowStartedAt)) / 1000));
      throw new RateLimitError(
        `${label} Try again in ${retryAfter}s. The hosted demo caps live diagnostics so it stays available to everyone.`,
        retryAfter
      );
    }
    entry.count += 1;
  }

  return {
    limits,

    /**
     * Reserve one slot. Returns a release function the caller MUST invoke in a
     * finally block, otherwise concurrency leaks and the endpoint wedges shut.
     */
    acquire(key) {
      const at = now();
      sweep(at);

      // Concurrency first: it consumes no budget, so a request refused here
      // has cost nobody anything.
      if (inFlight >= limits.maxConcurrent) {
        throw new RateLimitError(
          "The hosted demo is already running its maximum number of concurrent diagnostics. Try again in a few seconds.",
          5
        );
      }

      // The PER-CLIENT window is consumed before the instance one, and the
      // order matters. The other way round, a single client hammering past its
      // own limit still spent instance budget on every refused request, and
      // could lock everyone else out while being locked out itself - turning an
      // abuse control into an amplifier.
      const client = clients.get(key) || { windowStartedAt: at, count: 0 };
      consumeWindow(client, at, limits.perClientPerMinute, "You have reached the hosted demo's per-minute diagnostic limit.");
      clients.set(key, client);

      const instance = { windowStartedAt: instanceWindowStartedAt, count: instanceCount };
      consumeWindow(instance, at, limits.perInstancePerMinute, "This hosted demo instance has reached its per-minute diagnostic limit.");
      instanceWindowStartedAt = instance.windowStartedAt;
      instanceCount = instance.count;

      inFlight += 1;
      let released = false;
      let refunded = false;

      const release = () => {
        if (released) return;
        released = true;
        inFlight -= 1;
      };

      /**
       * Hand the live slot back, because the request never reached the network.
       *
       * Charged to the refusal bucket instead, so a client bouncing off policy
       * is still bounded - it just stops spending the budget that exists to
       * bound outbound work on requests that produced none. Throws
       * RateLimitError once that wider bucket is exhausted.
       */
      release.refund = () => {
        if (refunded) return;
        refunded = true;

        const at2 = now();
        const refusedKey = `refused:${key}`;
        const entry = clients.get(refusedKey) || { windowStartedAt: at2, count: 0 };

        // Give the live slot back first. A throw from the refusal bucket must
        // not leave the client charged for a request that did nothing.
        client.count = Math.max(0, client.count - 1);
        instanceCount = Math.max(0, instanceCount - 1);

        clients.set(refusedKey, entry);
        consumeWindow(
          entry,
          at2,
          limits.refusedPerClientPerMinute,
          "Too many refused targets in a row."
        );
      };

      return release;
    },

    snapshot() {
      return { inFlight, trackedClients: clients.size, instanceCount };
    },

    /** What the interface is allowed to claim about these controls. */
    describe() {
      return {
        perClientPerMinute: limits.perClientPerMinute,
        refusedPerClientPerMinute: limits.refusedPerClientPerMinute,
        perInstancePerMinute: limits.perInstancePerMinute,
        maxConcurrent: limits.maxConcurrent,
        requestBudgetMs: limits.requestBudgetMs,
        scope: "instance",
        durable: false,
        note: "Rate limits are enforced per hosted Function instance. Vercel scales instances horizontally, so this is a best-effort abuse control rather than a globally durable quota. The controls that do hold globally are the fixed target allowlist, hostname-only targets, ports 80/443 and full resolved-address validation."
      };
    }
  };
}
