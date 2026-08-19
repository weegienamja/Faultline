// Bounded sample ring.
//
// The Flight Recorder exists to hold evidence that normally disappears before
// anyone starts troubleshooting. It is explicitly NOT a time-series database:
// retention is a few minutes, in memory, and nothing is written to disk.
//
// Two bounds, both enforced, because either alone can be defeated:
//
//   window   samples older than the retention window are dropped, so the buffer
//            answers "the last N minutes" regardless of tick rate.
//   count    a hard cap, so a misconfigured 100 ms interval cannot exhaust
//            memory before the window bound has a chance to apply.
//
// `freeze` is the operation the trigger path depends on: it copies the current
// contents out of the ring so that continued sampling and eviction cannot erase
// the BEFORE window of an incident that is still being assembled.

const DEFAULT_WINDOW_MS = 3 * 60_000;
const DEFAULT_MAX_SAMPLES = 600;

export function createSampleBuffer({
  windowMs = DEFAULT_WINDOW_MS,
  maxSamples = DEFAULT_MAX_SAMPLES,
  now = () => Date.now()
} = {}) {
  let samples = [];

  function evict() {
    const cutoff = now() - windowMs;
    // Samples are appended in order, so the expired ones are always a prefix.
    let firstKept = 0;
    while (firstKept < samples.length && Date.parse(samples[firstKept].at) < cutoff) firstKept += 1;
    if (firstKept > 0) samples = samples.slice(firstKept);
    if (samples.length > maxSamples) samples = samples.slice(samples.length - maxSamples);
  }

  return {
    windowMs,
    maxSamples,

    push(sample) {
      samples.push(sample);
      evict();
      return sample;
    },

    /** Newest sample, or null. */
    latest() {
      return samples.length ? samples[samples.length - 1] : null;
    },

    /** The sample before the newest one - the comparison basis for triggers. */
    previous() {
      return samples.length > 1 ? samples[samples.length - 2] : null;
    },

    /**
     * A defensive copy of everything currently retained.
     * Callers hold incident evidence for longer than the ring does, so they
     * must not receive a reference that later mutates underneath them.
     */
    freeze() {
      evict();
      return samples.map(sample => structuredClone(sample));
    },

    /** Frozen copy of the samples immediately preceding `at`. */
    freezeBefore(at, limit = 40) {
      const cutoff = Date.parse(at);
      return samples
        .filter(sample => Date.parse(sample.at) < cutoff)
        .slice(-limit)
        .map(sample => structuredClone(sample));
    },

    size() {
      evict();
      return samples.length;
    },

    /** Oldest retained timestamp, so the UI can state actual coverage. */
    coverage() {
      evict();
      if (!samples.length) return null;
      return {
        from: samples[0].at,
        to: samples[samples.length - 1].at,
        samples: samples.length,
        windowMs
      };
    },

    clear() {
      samples = [];
    }
  };
}

export { DEFAULT_WINDOW_MS, DEFAULT_MAX_SAMPLES };
