const statusEl = document.getElementById("status");
let statusTimer = null;

function fmtTime(seconds) {
  if (seconds === null || seconds === undefined) return "-";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}分${rest}秒` : `${rest}秒`;
}

function renderStatus(data) {
  if (!data || !data.ok) {
    statusEl.textContent = (data && data.error) || "当前页面没有响应，请刷新 Facebook 页面后再试。";
    statusEl.className = "danger";
    return;
  }
  statusEl.className = "";
  const importingText = data.importing ? "正在导入" : (data.scanning ? "正在扫描" : "空闲");
  statusEl.textContent = [
    `状态：${data.messageZh || data.message || importingText}`,
    `已扫描：${data.queued || 0} 个客户`,
    `已导入：${data.imported || 0} 个客户`,
    `失败：${data.failed || 0} 个`,
    `剩余：${data.remaining || 0} 个`,
    `预计剩余：${fmtTime(data.etaSeconds)}`
  ].join("\n");
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(action, extra = {}) {
  const tab = await activeTab();
  if (!tab || !tab.id) {
    renderStatus({ ok: false, error: "没有找到当前页面。" });
    return null;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action, ...extra });
    renderStatus(response);
    return response;
  } catch (error) {
    renderStatus({ ok: false, error: "插件没有在当前页面生效。请刷新 Facebook / Messenger 页面后再点。" });
    return null;
  }
}

function pollStatus() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(() => send("status"), 1200);
}

document.getElementById("scan-import").addEventListener("click", async () => {
  await send("scanAndImport", {
    options: {
      maxCustomers: 3000,
      scanDelayMs: 1400,
      batchSize: 25,
      importDelayMs: 3000
    }
  });
  pollStatus();
});

document.getElementById("stop").addEventListener("click", () => send("stop"));

send("status");
pollStatus();
