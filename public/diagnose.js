const loadingCard = document.getElementById("loading-card");
const consentCard = document.getElementById("consent-card");
const commandCard = document.getElementById("command-card");
const errorCard = document.getElementById("error-card");
const consentCheck = document.getElementById("consent-check");
const includeTopology = document.getElementById("include-topology");
const claimButton = document.getElementById("claim-button");
const inviteError = document.getElementById("invite-error");
const commandOutput = document.getElementById("agent-command");
const copyButton = document.getElementById("copy-command");

let invitationToken = "";
let invitationSession = null;

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
  commandCard.hidden = true;
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

function buildAgentCommand(endpointToken) {
  const topologyOption = includeTopology.checked ? "" : " --no-topology";
  return `npm run agent -- --session ${invitationSession.id} --token ${endpointToken} --api-base ${window.location.origin}${topologyOption}`;
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
  inviteError.textContent = "Activating one-time endpoint access…";

  try {
    const payload = await request("/api/invitations/claim", {
      method: "POST",
      body: { consent: true }
    });
    const endpointToken = payload.credentials?.endpointToken;
    if (!endpointToken) throw new Error("Faultline did not return an endpoint credential.");

    sessionStorage.removeItem("faultlineInvitationToken");
    invitationToken = "";
    commandOutput.textContent = buildAgentCommand(endpointToken);
    consentCard.hidden = true;
    commandCard.hidden = false;
  } catch (error) {
    claimButton.disabled = false;
    inviteError.textContent = error.message;
  }
});

copyButton.addEventListener("click", async () => {
  const command = commandOutput.textContent;
  try {
    await navigator.clipboard.writeText(command);
    copyButton.textContent = "Copied";
  } catch {
    const range = document.createRange();
    range.selectNodeContents(commandOutput);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    copyButton.textContent = "Selected";
  }
  setTimeout(() => { copyButton.textContent = "Copy"; }, 1600);
});

loadInvitation();
