const ALLOWED_CHECK_TYPES = new Set(["dns", "tcp", "tls", "http"]);
const PLACEHOLDERS = new Set(["$target.host", "$target.port", "$target.url"]);

const builtins = [
  {
    id: "basic-reachability",
    version: 1,
    name: "Basic reachability",
    description: "Confirms that the diagnostic target resolves and accepts the requested TCP connection.",
    checks: [
      { id: "dns", type: "dns", label: "DNS resolution", required: true, host: "$target.host" },
      { id: "tcp", type: "tcp", label: "TCP connection", required: true, host: "$target.host", port: "$target.port" }
    ]
  },
  {
    id: "secure-web",
    version: 1,
    name: "Secure web service",
    description: "Checks the DNS, TCP, TLS and HTTP conditions required to reach a conventional HTTPS service.",
    checks: [
      { id: "dns", type: "dns", label: "DNS resolution", required: true, host: "$target.host" },
      { id: "tcp", type: "tcp", label: "TCP connection", required: true, host: "$target.host", port: "$target.port" },
      { id: "tls", type: "tls", label: "TLS handshake", required: true, host: "$target.host", port: "$target.port" },
      { id: "http", type: "http", label: "HTTP response", required: true, url: "$target.url", maxStatus: 499 }
    ]
  },
  {
    id: "web-api",
    version: 1,
    name: "Web API",
    description: "Checks a typical HTTPS API path while treating authentication and client errors as proof that the service path is reachable.",
    checks: [
      { id: "dns", type: "dns", label: "API DNS", required: true, host: "$target.host" },
      { id: "tcp", type: "tcp", label: "API TCP", required: true, host: "$target.host", port: "$target.port" },
      { id: "tls", type: "tls", label: "API TLS", required: true, host: "$target.host", port: "$target.port" },
      { id: "http", type: "http", label: "API HTTP", required: true, url: "$target.url", maxStatus: 499 }
    ]
  }
];

function boundedText(value, label, max = 180, required = true) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new Error(`${label} is required.`);
  if (text.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return text || null;
}

function normaliseTemplate(value, label, allowedPlaceholder = null) {
  const text = boundedText(value, label, 512);
  if (text?.startsWith("$target.")) {
    if (!PLACEHOLDERS.has(text) || (allowedPlaceholder && text !== allowedPlaceholder)) {
      throw new Error(`${label} uses an unsupported target placeholder.`);
    }
  }
  return text;
}

function normaliseCheck(input, index) {
  if (!input || typeof input !== "object") throw new Error(`Connectivity contract check ${index + 1} must be an object.`);
  const type = String(input.type || "").trim().toLowerCase();
  if (!ALLOWED_CHECK_TYPES.has(type)) throw new Error(`Unsupported connectivity contract check type: ${type || "missing"}.`);

  const check = {
    id: boundedText(input.id || `${type}-${index + 1}`, `Check ${index + 1} id`, 64),
    type,
    label: boundedText(input.label || type.toUpperCase(), `Check ${index + 1} label`, 120),
    required: input.required !== false,
    timeoutMs: Math.max(500, Math.min(15_000, Number(input.timeoutMs || (type === "http" ? 6_000 : 3_500))))
  };

  if (type === "dns") {
    check.host = normaliseTemplate(input.host || "$target.host", `Check ${check.id} host`, "$target.host");
  }
  if (type === "tcp" || type === "tls") {
    check.host = normaliseTemplate(input.host || "$target.host", `Check ${check.id} host`, "$target.host");
    const port = input.port ?? "$target.port";
    if (port === "$target.port") check.port = port;
    else {
      const numeric = Number(port);
      if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) throw new Error(`Check ${check.id} port must be 1-65535 or $target.port.`);
      check.port = numeric;
    }
  }
  if (type === "http") {
    check.url = normaliseTemplate(input.url || "$target.url", `Check ${check.id} URL`, "$target.url");
    const maxStatus = Number(input.maxStatus ?? 499);
    if (!Number.isInteger(maxStatus) || maxStatus < 199 || maxStatus > 599) throw new Error(`Check ${check.id} maxStatus must be 199-599.`);
    check.maxStatus = maxStatus;
  }

  return check;
}

export function validateConnectivityContract(input) {
  if (!input || typeof input !== "object") throw new Error("Connectivity contract must be an object.");
  const checks = Array.isArray(input.checks) ? input.checks : [];
  if (!checks.length) throw new Error("Connectivity contract requires at least one check.");
  if (checks.length > 16) throw new Error("Connectivity contract may contain at most 16 checks.");

  const contract = {
    id: boundedText(input.id, "Connectivity contract id", 80),
    version: Number(input.version || 1),
    name: boundedText(input.name, "Connectivity contract name", 120),
    description: boundedText(input.description || "Connectivity requirements for this diagnostic target.", "Connectivity contract description", 400),
    checks: checks.map(normaliseCheck)
  };

  if (!Number.isInteger(contract.version) || contract.version < 1 || contract.version > 10_000) {
    throw new Error("Connectivity contract version must be a positive integer.");
  }
  if (new Set(contract.checks.map(check => check.id)).size !== contract.checks.length) {
    throw new Error("Connectivity contract check ids must be unique.");
  }
  if (!contract.checks.some(check => check.required)) throw new Error("Connectivity contract requires at least one required check.");
  return contract;
}

export const CONNECTIVITY_CONTRACTS = Object.freeze(builtins.map(contract => Object.freeze(validateConnectivityContract(contract))));

export function listConnectivityContracts() {
  return CONNECTIVITY_CONTRACTS.map(contract => structuredClone(contract));
}

export function getConnectivityContract(id) {
  const contract = CONNECTIVITY_CONTRACTS.find(item => item.id === String(id || "").trim());
  if (!contract) {
    const error = new Error(`Connectivity contract ${id} was not found.`);
    error.statusCode = 404;
    throw error;
  }
  return structuredClone(contract);
}

export function resolveConnectivityContract(input = {}) {
  if (input.connectivityContract) return validateConnectivityContract(input.connectivityContract);
  if (input.contractId) return getConnectivityContract(input.contractId);
  return null;
}

function resolveValue(value, target) {
  if (value === "$target.host") return target.host;
  if (value === "$target.port") return target.port;
  if (value === "$target.url") return target.url || `https://${target.host}${target.port === 443 ? "" : `:${target.port}`}/`;
  return value;
}

export function resolveContractCheck(check, target) {
  const resolved = { ...check };
  if ("host" in resolved) resolved.host = resolveValue(resolved.host, target);
  if ("port" in resolved) resolved.port = Number(resolveValue(resolved.port, target));
  if ("url" in resolved) resolved.url = String(resolveValue(resolved.url, target));
  return resolved;
}

export function summariseContractRun(contract, checks) {
  if (!contract) return null;
  const results = Array.isArray(checks) ? checks : [];
  const required = results.filter(result => result.required !== false);
  const failed = required.filter(result => result.ok !== true);
  const passed = required.length - failed.length;
  return {
    contract: { id: contract.id, version: contract.version, name: contract.name },
    requiredChecks: required.length,
    passedRequired: passed,
    failedRequired: failed.length,
    passRate: required.length ? Number(((passed / required.length) * 100).toFixed(1)) : 0,
    passed: failed.length === 0 && required.length > 0,
    firstFailureType: failed[0]?.type || null,
    checks: results
  };
}
