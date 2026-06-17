const statusEl = document.getElementById("status");
let statusTimer = null;

function value(id) {
  return Number(document.getElementById(id).value || 0);
}

function options() {
  return {
    maxCustomers: value("maxCustomers") || 3000,
    scanDelayMs: value("scanDelayMs") || 1400,
    batchSize: value("batchSize") || 25,
    importDelayMs: value("importDelayMs") || 3000
  };
}

function fmtTime(seconds) {
  if (seconds === null || seconds === undefined) return "-";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}

function renderStatus(data) {
  if (!data || !data.ok) {
    statusEl.textContent = (data && data.error) || "No page response. Refresh Facebook/Messenger and try again.";
    statusEl.className = "danger";
    return;
  }
  statusEl.className = "";
  statusEl.textContent = [
    `Status: ${data.message || "Ready"}`,
    `Queue: ${data.queued || 0}`,
    `Imported: ${data.imported || 0}`,
    `Failed: ${data.failed || 0}`,
    `Remaining: ${data.remaining || 0}`,
    `Scan rounds: ${data.scanRounds || 0}`,
    `No-new rounds: ${data.stagnantRounds || 0}`,
    `Duplicate seen: ${data.duplicateInPage || 0}`,
    `Scanning: ${data.scanning ? "yes" : "no"} | Importing: ${data.importing ? "yes" : "no"} | Paused: ${data.paused ? "yes" : "no"}`,
    `Elapsed: ${fmtTime(data.elapsed || 0)} | ETA: ${fmtTime(data.etaSeconds)}`
  ].join("\n");
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(action, extra = {}) {
  const tab = await activeTab();
  if (!tab || !tab.id) {
    renderStatus({ ok: false, error: "No active tab found." });
    return null;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action, ...extra });
    renderStatus(response);
    return response;
  } catch (error) {
    renderStatus({ ok: false, error: "Extension is not active on this page. Refresh Facebook/Messenger and try again." });
    return null;
  }
}

function pollStatus() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(() => send("status"), 1200);
}

document.getElementById("scan-all").addEventListener("click", async () => {
  await send("scanAll", { options: options() });
  pollStatus();
});
document.getElementById("import-queue").addEventListener("click", async () => {
  await send("importQueue", { options: options() });
  pollStatus();
});
document.getElementById("stop").addEventListener("click", () => send("stop"));
document.getElementById("pause").addEventListener("click", () => send("pauseImport"));
document.getElementById("resume").addEventListener("click", () => send("resumeImport"));
document.getElementById("scan-visible").addEventListener("click", () => send("scanVisible"));
document.getElementById("save-current").addEventListener("click", () => send("captureCurrent"));
document.getElementById("clear").addEventListener("click", () => send("clearQueue"));
document.getElementById("test-config").addEventListener("click", () => send("testConfig"));

send("status");
pollStatus();
