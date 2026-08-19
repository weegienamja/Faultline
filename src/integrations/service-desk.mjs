import { createHmac, randomBytes } from "node:crypto";

const PROVIDERS = Object.freeze([
  { id: "servicenow", name: "ServiceNow" },
  { id: "jira-service-management", name: "Jira Service Management" },
  { id: "zendesk", name: "Zendesk" },
  { id: "halopsa", name: "HaloPSA" },
  { id: "freshservice", name: "Freshservice" },
  { id: "connectwise", name: "ConnectWise" },
  { id: "generic-webhook", name: "Generic webhook" }
]);

function clean(value, fallback = "", max = 200, field = "value") {
  const text = String(value ?? fallback).trim();
  if (!text) return "";
  if (text.length > max) throw new Error(`${field} must be ${max} characters or fewer.`);
  return text;
}

export function listServiceDeskProviders() {
  return PROVIDERS.map(item => ({ ...item, capabilities: ["ticket-correlation", "diagnostic-launch", "evidence-link", "status-summary"] }));
}

export function configureServiceDesk(input = {}, now = Date.now()) {
  const provider = clean(input.provider, "", 80, "provider").toLowerCase();
  if (!PROVIDERS.some(item => item.id === provider)) throw new Error(`Unsupported service desk provider: ${provider || "(missing)"}.`);
  const externalTicketId = clean(input.externalTicketId || input.ticketId, "", 160, "externalTicketId");
  if (!externalTicketId) throw new Error("externalTicketId is required.");
  const createdAt = new Date(now).toISOString();
  return {
    id: `INT-${randomBytes(6).toString("hex").toUpperCase()}`,
    provider,
    externalTicketId,
    externalTicketUrl: clean(input.externalTicketUrl, "", 500, "externalTicketUrl") || null,
    displayLabel: clean(input.displayLabel, "", 160, "displayLabel") || null,
    createdAt,
    updatedAt: createdAt,
    enabled: input.enabled !== false
  };
}

function latestDiagnosis(evidence) {
  const runs = Array.isArray(evidence?.evidence?.runs) ? evidence.evidence.runs : [];
  return [...runs]
    .filter(item => item?.diagnosis)
    .sort((a, b) => String(a.collectedAt || a.updatedAt || "").localeCompare(String(b.collectedAt || b.updatedAt || "")))
    .at(-1)?.diagnosis || null;
}

function latestRun(evidence) {
  return [...(evidence?.evidence?.runs || [])]
    .sort((a, b) => String(a.collectedAt || a.updatedAt || "").localeCompare(String(b.collectedAt || b.updatedAt || "")))
    .at(-1) || null;
}

export function buildServiceDeskUpdate({ integration, caseRecord, evidence, baseUrl = null, reason = "diagnostic.updated" } = {}) {
  if (!integration?.provider || !integration?.externalTicketId) throw new Error("A configured service desk integration is required.");
  if (!caseRecord?.id) throw new Error("Support case is required.");

  const provider = PROVIDERS.find(item => item.id === integration.provider);
  const diagnosis = latestDiagnosis(evidence);
  const run = latestRun(evidence);
  const evidenceUrl = baseUrl ? `${String(baseUrl).replace(/\/$/, "")}/api/cases/${encodeURIComponent(caseRecord.id)}/report?redaction=network-identifiers` : null;
  const faultDomain = diagnosis?.faultDomain || "inconclusive";
  const confidence = diagnosis?.confidence ?? null;
  const title = `Faultline update · ${caseRecord.title || caseRecord.id}`;
  const summary = diagnosis
    ? `Faultline evidence currently supports ${String(faultDomain).replaceAll("_", " ")}${confidence != null ? ` (${confidence}% confidence)` : ""}.`
    : "Faultline has not yet produced a deterministic fault-domain conclusion for this case.";

  return {
    schema: "faultline.service-desk-update.v1",
    generatedAt: new Date().toISOString(),
    reason,
    provider: { id: provider?.id || integration.provider, name: provider?.name || integration.provider },
    ticket: {
      id: integration.externalTicketId,
      url: integration.externalTicketUrl || null,
      label: integration.displayLabel || null
    },
    case: {
      id: caseRecord.id,
      title: caseRecord.title,
      customer: caseRecord.customer,
      status: caseRecord.status,
      severity: caseRecord.severity,
      externalRef: caseRecord.externalRef || null
    },
    update: {
      title,
      summary,
      faultDomain,
      confidence,
      latestSessionId: run?.sessionId || run?.id || null,
      evidenceUrl
    },
    provenance: {
      source: "Faultline",
      evidencePackageDigest: evidence?.integrity?.sha256 || null,
      diagnosisMode: "deterministic",
      statisticalSimilarityIsRootCause: false
    }
  };
}

export function signIntegrationEnvelope(payload, secret, timestamp = Date.now()) {
  if (!secret) throw new Error("Signing secret is required.");
  const issuedAt = new Date(timestamp).toISOString();
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", String(secret)).update(`${issuedAt}.${body}`).digest("hex");
  return { issuedAt, algorithm: "hmac-sha256", signature, payload };
}

export function verifyIntegrationEnvelope(envelope, secret) {
  if (!envelope?.issuedAt || !envelope?.signature || !envelope?.payload || !secret) return false;
  const body = JSON.stringify(envelope.payload);
  const expected = createHmac("sha256", String(secret)).update(`${envelope.issuedAt}.${body}`).digest("hex");
  if (expected.length !== String(envelope.signature).length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ String(envelope.signature).charCodeAt(index);
  return mismatch === 0;
}
