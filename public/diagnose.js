const loadingCard = document.getElementById("loading-card");
const consentCard = document.getElementById("consent-card");
const clientCard = document.getElementById("client-card");
const errorCard = document.getElementById("error-card");
const consentCheck = document.getElementById("consent-check");
const includeTopology = document.getElementById("include-topology");
const claimButton = document.getElementById("claim-button");
const inviteError = document.getElementById("invite-error");
const saveHandoffButton = document.getElementById("save-handoff");
const handoffName = document.getElementById("handoff-name");
const downloadClient = document.getElementById("download-client");
const clientUnavailable = document.getElementById("client-unavailable");
const clientWarning = document.getElementById("client-warning");

let invitationToken = "";
let invitationSession = null;
let handoffPayload = null;

function tokenFromLocation() {
  const match = window.location.hash.match(/^#invite=(.+)$/);
  if (match) {
    try {
      const token = decodeURIComponent(match[1]);
      sessionStorage.setItem("faultlineInvitationToken", token);
      history.replaceState(null, "", "/diagnose");
      return token;
    } catch {
      return "";
    }
  }
  return sessionStorage.getItem("faultlineInvitationToken") || "";
}

function showFatal(title, message) {
  loadingCard.hidden = true;
  consentCard.hidden = true;
  clientCard.hidden = true;
  errorCard.hidden = false;
  document.getElementById("fatal-title").textContent = title;
  document.getElementById("fatal-message").textContent = message;
}

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: {
      authorization: `Bearer ${invitationToken}`,
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

function renderInvitation(session) {
  invitationSession = session;
  document.getElementById("invite-title").textContent = session.title;
  document.getElementById("invite-target").textContent = `${session.target.input}:${session.target.port}`;
  document.getElementById("invite-customer").textContent = session.customer;
  document.getElementById("invite-expires").textContent = new Date(session.expiresAt).toLocaleString();
  loadingCard.hidden = true;
  consentCard.hidden = false;
}

function downloadHandoff() {
  if (!handoffPayload) return;
  const filename = `Faultline-${handoffPayload.sessionId}.faultline`;
  const blob = new Blob([`${JSON.stringify(handoffPayload, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
  handoffName.textContent = `${filename} has been prepared for this one-time diagnostic.`;
}

function showClientInstructions(payload) {
  const launchToken = payload.client?.launchToken;
  if (!launchToken) throw new Error("Faultline did not return a Windows client launch credential.");

  handoffPayload = {
    version: 1,
    sessionId: invitationSession.id,
    apiBase: window.location.origin,
    launchToken,
    createdAt: new Date().toISOString()
  };

  const clientUrl = payload.client?.windowsDownloadUrl || null;
  if (clientUrl) {
    downloadClient.href = clientUrl;
    downloadClient.hidden = false;
    clientUnavailable.hidden = true;
    clientWarning.hidden = true;
  } else {
    downloadClient.hidden = true;
    clientUnavailable.hidden = false;
    clientWarning.hidden = false;
  }

  consentCard.hidden = true;
  clientCard.hidden = false;
  downloadHandoff();
}

async function loadInvitation() {
  invitationToken = tokenFromLocation();
  if (!invitationToken) {
    showFatal("Invitation link missing", "Open the complete one-time link supplied by your support engineer. The invitation secret is carried in the link fragment and is not available on this page without that link.");
    return;
  }

  try {
    const payload = await request("/api/invitations");
    if (payload.session?.invitation?.status !== "available") {
      sessionStorage.removeItem("faultlineInvitationToken");
      showFatal("Invitation already used", "This one-time diagnostic invitation has already been claimed or is no longer active. Ask the support engineer to create another invitation if a new diagnostic is required.");
      return;
    }
    renderInvitation(payload.session);
  } catch (error) {
    sessionStorage.removeItem("faultlineInvitationToken");
    if (error.status === 410) {
      showFatal("Invitation expired", "This diagnostic invitation has expired. Ask the support engineer to create a new one.");
    } else {
      showFatal("Invitation not recognised", "This diagnostic invitation is invalid, has already been consumed, or is no longer available.");
    }
  }
}

consentCheck.addEventListener("change", () => {
  claimButton.disabled = !consentCheck.checked;
});

claimButton.addEventListener("click", async () => {
  if (!consentCheck.checked) return;
  claimButton.disabled = true;
  inviteError.textContent = "Preparing one-time Windows client access…";

  try {
    const payload = await request("/api/invitations/claim", {
      method: "POST",
      body: {
        consent: true,
        includeTopology: includeTopology.checked
      }
    });

    sessionStorage.removeItem("faultlineInvitationToken");
    invitationToken = "";
    inviteError.textContent = "";
    showClientInstructions(payload);
  } catch (error) {
    claimButton.disabled = false;
    inviteError.textContent = error.message;
  }
});

saveHandoffButton.addEventListener("click", downloadHandoff);

loadInvitation();
