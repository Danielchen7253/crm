const statusEl = document.getElementById("status");
let statusTimer = null;

function renderStatus(data) {
  if (!data || !data.ok) {
    statusEl.textContent = (data && data.error) || "当前页面没有响应，请刷新 Facebook 页面后再试。";
    return;
  }

  const mode = data.importing ? "正在上传" : (data.running ? "正在采集" : "空闲");
  statusEl.textContent = [
    `状态：${mode}`,
    `提示：${data.message || "准备就绪"}`,
    `已抓取：${data.queued || 0}/${data.target || 50}`,
    `已上传：${data.imported || 0}`,
    `失败：${data.failed || 0}`
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

document.getElementById("start").addEventListener("click", async () => {
  await send("startWatching", { target: 50 });
  pollStatus();
});

document.getElementById("upload").addEventListener("click", async () => {
  await send("uploadAndClear");
  pollStatus();
});

document.getElementById("scan-now").addEventListener("click", async () => {
  await send("scanNow");
  pollStatus();
});

send("status");
pollStatus();
