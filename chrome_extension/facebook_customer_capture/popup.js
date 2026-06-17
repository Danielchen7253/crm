const statusEl = document.getElementById("status");
let statusTimer = null;

function renderStatus(data) {
  if (!data || !data.ok) {
    statusEl.textContent = (data && data.error) || "Page is not ready. Refresh Facebook and try again.";
    return;
  }

  statusEl.textContent = [
    `Status: ${data.running ? "Running" : "Idle"}`,
    `Message: ${data.message || "Ready"}`,
    `Queue: ${data.index || 0}/${data.total || 0}`,
    `Uploaded: ${data.saved || 0}`,
    `Failed: ${data.failed || 0}`,
    `Skipped: ${data.skipped || 0}`
  ].join("\n");
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function supportedPage(tab) {
  const url = String((tab && tab.url) || "");
  return url.startsWith("https://www.facebook.com/")
    || url.startsWith("https://facebook.com/")
    || url.startsWith("https://business.facebook.com/")
    || url.startsWith("https://www.messenger.com/")
    || url.startsWith("https://messenger.com/");
}

async function injectCaptureScript(tab) {
  if (!supportedPage(tab)) {
    throw new Error("Open a Facebook, Messenger, or Marketplace customer page first.");
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["config.js", "content.js"]
  });
}

async function sendOnce(tab, action) {
  return chrome.tabs.sendMessage(tab.id, { action });
}

async function send(action) {
  const tab = await activeTab();
  if (!tab || !tab.id) {
    renderStatus({ ok: false, error: "No active page found." });
    return null;
  }

  try {
    const response = await sendOnce(tab, action);
    renderStatus(response);
    return response;
  } catch (firstError) {
    try {
      renderStatus({ ok: true, message: "Injecting capture script...", running: false });
      await injectCaptureScript(tab);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const response = await sendOnce(tab, action);
      renderStatus(response);
      return response;
    } catch (secondError) {
      renderStatus({ ok: false, error: secondError.message || firstError.message || "Capture script failed." });
      return null;
    }
  }
}

function pollStatus() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(() => send("status"), 1500);
}

document.getElementById("start").addEventListener("click", async () => {
  await send("startSequentialCapture");
  pollStatus();
});

document.getElementById("stop").addEventListener("click", async () => {
  await send("stopSequentialCapture");
  pollStatus();
});

document.getElementById("capture-current").addEventListener("click", async () => {
  await send("captureCurrentOnly");
  pollStatus();
});

send("status");
pollStatus();
