// Assembling a recorded investigation into the full Faultline loop.
//
//   CAPTURE    Flight Recorder incident, built by the production recorder
//   ISOLATE    Network Bisect report, produced by the production engine
//   EXPLAIN    the deterministic verdict, plus an honest statement about why
//              the Analyst is not available on a hosted deployment
//   PRESERVE   a portable Incident Capsule, built by the production exporter
//
// Replays are deterministic and identical on every request, so each one is
// computed once per Function instance and cached. Recomputing a fixed result
// per visitor would burn CPU to produce the same bytes.

import { buildCapsule, capsuleFilename } from "../evidence/capsule.mjs";
import { renderCapsuleHtml } from "../evidence/capsule-html.mjs";
import { buildBisectAttachment, summariseAttachment } from "../recorder/attachments.mjs";
import { summariseIncident } from "../recorder/incident.mjs";
import { DEMO_INCIDENTS, findDemoIncident } from "./catalogue.mjs";
import { loadDemoScenario, replayBisect, replayIncident } from "./replay.mjs";

/** Every artefact a replayed investigation carries. Set once, then reused. */
const cache = new Map();
/** In-flight builds, so concurrent requests do not replay the same demo twice. */
const building = new Map();

export const DEMO_EVIDENCE_NOTICE = Object.freeze({
  label: "RECORDED DEMO INCIDENT",
  evidenceClass: "simulated",
  headline: "Recorded demonstration. Not a measurement of any real network.",
  detail:
    "Sample data comes from a scenario file. It is replayed through Faultline's production Flight Recorder and Network Bisect engines on a virtual clock, so the capture, comparison, experiment selection, A/B confirmation and verdict are all real product behaviour. The network being described is not."
});

async function build(entry) {
  const scenario = await loadDemoScenario(entry.scenario);
  const incident = await replayIncident(scenario, { id: entry.id });

  // Only the conditions the recorder actually observed changing are tested,
  // which is the same restriction the real recorder-to-Bisect handoff applies.
  const requestedAxes = incident.candidateDiscriminators?.bisectAxes ?? [];

  const report = requestedAxes.length
    ? await replayBisect({
        target: entry.bisect.target,
        port: entry.bisect.port,
        world: entry.bisect.world,
        answerSets: entry.bisect.answerSets,
        interfaces: entry.bisect.interfaces,
        resolvers: entry.bisect.resolvers,
        axes: requestedAxes
      })
    : null;

  const attachment = report
    ? buildBisectAttachment({ incident, report, requestedAxes, simulated: true })
    : null;

  const capsule = buildCapsule({
    incident,
    attachments: attachment ? [attachment] : [],
    redaction: "none",
    faultlineVersion: "v1.5-hosted-demo"
  });

  return {
    id: entry.id,
    slug: entry.slug,
    title: entry.title,
    subtitle: entry.subtitle,
    scenario: { name: scenario.scenario, title: scenario.title, description: scenario.description, phases: scenario.phases.length, durationMs: scenario.totalMs },
    whyRecorded: entry.whyRecorded,
    story: entry.story,
    notice: DEMO_EVIDENCE_NOTICE,
    incident,
    bisect: report,
    attachment,
    capsule,
    capsuleFilename: capsuleFilename(entry.id)
  };
}

/** Build (or reuse) one investigation. Concurrent callers share one build. */
export async function getInvestigation(reference) {
  const entry = findDemoIncident(reference);
  if (!entry) {
    const error = new Error(`No recorded demo investigation matches "${String(reference).slice(0, 40)}".`);
    error.statusCode = 404;
    throw error;
  }
  if (cache.has(entry.id)) return cache.get(entry.id);
  if (building.has(entry.id)) return building.get(entry.id);

  const pending = build(entry)
    .then(result => {
      cache.set(entry.id, result);
      return result;
    })
    .finally(() => building.delete(entry.id));

  building.set(entry.id, pending);
  return pending;
}

/**
 * The catalogue listing.
 *
 * Deliberately does NOT replay anything: a visitor loading the page should not
 * pay for three isolation runs before they have chosen one. The counts that
 * need a replay are absent here and appear once an investigation is opened.
 */
export function listInvestigations() {
  return DEMO_INCIDENTS.map(entry => ({
    id: entry.id,
    slug: entry.slug,
    title: entry.title,
    subtitle: entry.subtitle,
    faultDomainHint: entry.faultDomainHint,
    whyRecorded: entry.whyRecorded,
    scenario: entry.scenario,
    notice: DEMO_EVIDENCE_NOTICE,
    ready: cache.has(entry.id)
  }));
}

/**
 * The projection the browser renders.
 *
 * Full sample windows are large and the interface only draws a timeline from
 * them, so the chronology is summarised here rather than shipping every field
 * of every sample. The complete record is still available in the capsule.
 */
export function projectInvestigation(investigation) {
  const { incident, bisect } = investigation;

  const timelineOf = (samples, window) => samples.map(sample => ({
    at: sample.at,
    window,
    phase: sample.phase || null,
    state: sample.state,
    reasons: sample.reasons || [],
    targetTcp: sample.connectivity?.targetTcp?.state ?? null,
    targetTcpError: sample.connectivity?.targetTcp?.error ?? null,
    targetTcpMs: sample.connectivity?.targetTcp?.ms ?? null,
    ipv4: sample.connectivity?.ipv4?.state ?? null,
    ipv6: sample.connectivity?.ipv6?.state ?? null,
    dns: sample.connectivity?.targetDns?.state ?? null,
    activeInterface: sample.local?.activeInterface ?? null,
    gateway: sample.local?.gateway ?? null,
    resolvers: sample.local?.resolvers ?? [],
    vpn: sample.local?.vpn?.active === true,
    route: sample.local?.route
      ? `${sample.local.route.destination} via ${sample.local.route.nextHop} on ${sample.local.route.interfaceAlias}`
      : null,
    resolvedAddress: sample.path?.resolvedAddress ?? null
  }));

  return {
    id: investigation.id,
    slug: investigation.slug,
    title: investigation.title,
    subtitle: investigation.subtitle,
    whyRecorded: investigation.whyRecorded,
    story: investigation.story,
    notice: investigation.notice,
    scenario: investigation.scenario,

    capture: {
      summary: summariseIncident(incident),
      target: incident.target,
      trigger: incident.trigger,
      concurrentTriggers: incident.concurrentTriggers,
      // Counts and bounds rather than the samples themselves: this is what the
      // chronology rail draws, and it keeps the payload small enough to render
      // three investigations without shipping every field of every sample.
      windows: {
        before: { count: incident.windows.before.samples.length, from: incident.windows.before.from, to: incident.windows.before.to },
        during: { count: incident.windows.during.samples.length, from: incident.windows.during.from, to: incident.windows.during.to },
        after: { count: incident.windows.after.samples.length, from: incident.windows.after.from, to: incident.windows.after.to }
      },
      hadFailure: incident.observedChange?.hadFailure !== false,
      recovery: incident.observedChange?.recovery ? { at: incident.observedChange.recovery.at } : null,
      timeline: [
        ...timelineOf(incident.windows.before.samples, "before"),
        ...timelineOf(incident.windows.during.samples, "during"),
        ...timelineOf(incident.windows.after.samples, "after")
      ],
      observedChange: incident.observedChange,
      candidateDiscriminators: incident.candidateDiscriminators,
      epistemics: incident.epistemics,
      closedAt: incident.closedAt,
      closeReason: incident.closeReason
    },

    isolate: bisect
      ? {
          available: true,
          evidenceId: investigation.attachment?.id ?? null,
          evidenceClass: investigation.attachment?.evidenceClass ?? "simulated",
          requestedAxes: investigation.attachment?.origin?.requestedAxes ?? [],
          target: bisect.target,
          baseline: bisect.baseline,
          experimentsAvailable: bisect.experimentsAvailable,
          executed: bisect.executed,
          skipped: bisect.skipped,
          axesUnavailable: bisect.axesUnavailable,
          hypotheses: bisect.hypotheses,
          confirmation: bisect.confirmation,
          transcript: bisect.transcript,
          counters: bisect.counters,
          verdict: bisect.verdict,
          evidence: bisect.evidence
        }
      : {
          available: false,
          reason: "This incident produced no condition that Network Bisect can vary."
        },

    explain: {
      // The deterministic engine is the only thing that decides a finding. The
      // Analyst is an interpretation layer and is absent here by design.
      deterministic: bisect?.verdict
        ? {
            classification: bisect.verdict.classification,
            headline: bisect.verdict.headline,
            claim: bisect.verdict.claim,
            detail: bisect.verdict.detail ?? null,
            workaround: bisect.verdict.workaround ?? null,
            stop: bisect.verdict.stop
          }
        : null,
      observedStatement: incident.observedChange?.statement ?? null,
      limit: "Network Bisect establishes that changing a condition changes the outcome. That is association under a controlled variation, not proof of cause."
    },

    preserve: {
      capsuleId: investigation.capsule?.incident?.id ?? investigation.id,
      filename: investigation.capsuleFilename,
      integrity: investigation.capsule?.integrity ?? null,
      attachments: investigation.attachment ? [summariseAttachment(investigation.attachment)] : [],
      htmlPath: `/api/demo/incidents/${investigation.slug}/capsule`,
      jsonPath: `/api/demo/incidents/${investigation.slug}/capsule?format=json`
    }
  };
}

export function renderInvestigationCapsule(investigation) {
  return renderCapsuleHtml(investigation.capsule);
}
