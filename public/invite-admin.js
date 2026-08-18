const openButton = document.getElementById("invite-open");
const dialog = document.getElementById("invite-dialog");
const form = document.getElementById("invite-form");
const cancelButton = document.getElementById("invite-cancel");
const createButton = document.getElementById("invite-create");
const errorBox = document.getElementById("invite-admin-error");
const resultBox = document.getElementById("invite-result");
const linkOutput = document.getElementById("invite-link");
const copyButton = document.getElementById("invite-copy");
const probeSelect = document.getElementById("invite-probe");

const AUTO_PROBE = "__auto__";

function adminToken() {
  return sessionStorage.getItem("faultlineAdminToken") || "";
}

async function request(path, { method = "GET", body } = {}) {
  const token = adminToken();
  if (!token) {
    const error = new Error("Unlock live data with the Faultline admin credential first.");
    error.status = 401;
    throw error;
  }

  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Faultline returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function loadProbes() {
  const probes = await request("/api/probes");
  const current = probeSelect.value || AUTO_PROBE;
  probeSelect.innerHTML = [
    '<option value="__auto__">Automatic · best online public probe</option>',
    '<option value="">One-off probe / assign later</option>'
  ].join("");

  probes
    .filter(probe => !["disabled", "revoked", "maintenance"].includes(probe.health))
    .forEach(probe => {
      const option = document.createElement("option");
      option.value = probe.id;
      const scope = probe.scope || "public";
      option.textContent = `${probe.name}${probe.location ? ` · ${probe.location}` : ""} · ${scope} · ${probe.health}`;
      probeSelect.appendChild(option);
    });

  probeSelect.value = [...probeSelect.options].some(option => option.value === current) ? current : AUTO_PROBE;
}

openButton.addEventListener("click", async () => {
  errorBox.textContent = "";
  resultBox.hidden = true;

  if (!adminToken()) {
    document.getElementById("auth-open")?.click();
    return;
  }

  try {
    await loadProbes();
    dialog.showModal();
    document.getElementById("invite-target").focus();
  } catch (error) {
    errorBox.textContent = error.message;
    dialog.showModal();
  }
});

cancelButton.addEventListener("click", () => dialog.close());

form.addEventListener("submit", async event => {
  event.preventDefault();
  errorBox.textContent = "Creating one-time invitation…";
  resultBox.hidden = true;
  createButton.disabled = true;

  const target = document.getElementById("invite-target").value.trim();
  const title = document.getElementById("invite-case-title").value.trim();
  const customer = document.getElementById("invite-customer").value.trim();
  const ttlMinutes = Number(document.getElementById("invite-ttl").value);
  const choice = probeSelect.value;
  const assignedProbeId = choice && choice !== AUTO_PROBE ? choice : undefined;
  const probeSelector = choice === AUTO_PROBE ? { scope: "public" } : undefined;

  try {
    const payload = await request("/api/sessions", {
      method: "POST",
      body: {
        target,
        title: title || undefined,
        customer: customer || undefined,
        ttlMinutes,
        assignedProbeId,
        probeSelector,
        ephemeral: true
      }
    });

    if (!payload.invitation?.path) throw new Error("Faultline did not return an invitation path.");
    const inviteUrl = `${window.location.origin}${payload.invitation.path}`;
    linkOutput.textContent = inviteUrl;
    resultBox.hidden = false;
    const probeText = payload.session.assignedProbeId
      ? ` Remote probe ${payload.session.assignedProbeId} assigned ${payload.session.probeSelection?.mode === "automatic" ? "automatically" : "explicitly"}.`
      : " No registered probe assigned.";
    errorBox.textContent = `Session ${payload.session.id} created. The invitation expires ${new Date(payload.session.expiresAt).toLocaleString()}.${probeText}`;
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    createButton.disabled = false;
  }
});

copyButton.addEventListener("click", async () => {
  const value = linkOutput.textContent;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    copyButton.textContent = "Copied";
  } catch {
    const range = document.createRange();
    range.selectNodeContents(linkOutput);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    copyButton.textContent = "Selected";
  }
  setTimeout(() => { copyButton.textContent = "Copy link"; }, 1600);
});
