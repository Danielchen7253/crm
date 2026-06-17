const statusEl = document.getElementById("status");
let statusTimer = null;

function renderStatus(data) {
  if (!data || !data.ok) {
    statusEl.textContent = (data && data.error) || "当前页面没有响应，请刷新 Facebook 页面后再试。";
    return;
  }

  statusEl.textContent = [
    `状态：${data.running ? "挂机采集中" : "空闲"}`,
    `提示：${data.message || "准备就绪"}`,
    `已发现：${data.scanned || 0}`,
    `待上传：${data.queued || 0}`,
    `已上传：${data.uploaded || 0}`,
    `失败：${data.failed || 0}`,
    `扫描轮次：${data.rounds || 0}`
  ].join("\n");
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(action) {
  const tab = await activeTab();
  if (!tab || !tab.id) {
    renderStatus({ ok: false, error: "没有找到当前页面。" });
    return null;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action });
    renderStatus(response);
    return response;
  } catch (error) {
    renderStatus({ ok: false, error: "插件没有在当前页面生效。请刷新 Facebook / Messenger 页面后再点。" });
    return null;
  }
}

function pollStatus() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(() => send("status"), 1500);
}

document.getElementById("start").addEventListener("click", async () => {
  await send("startAutoCapture");
  pollStatus();
});

document.getElementById("stop").addEventListener("click", async () => {
  await send("stopAutoCapture");
  pollStatus();
});

document.getElementById("scan-visible").addEventListener("click", async () => {
  await send("scanVisible");
  pollStatus();
});

send("status");
pollStatus();
