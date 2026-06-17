const statusEl = document.getElementById("status");

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? "danger" : "";
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToPage(action) {
  const tab = await activeTab();
  if (!tab || !tab.id) {
    setStatus("没有找到当前页面。", true);
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action });
    if (!response || !response.ok) {
      setStatus((response && response.error) || "页面没有响应，刷新 Facebook 页面后再试。", true);
      return;
    }
    if (action === "captureCurrent") {
      setStatus(`已保存：${response.result.display_name || "当前客户"}`);
    } else {
      setStatus(`已扫描并提交 ${response.saved || 0} 个客户。`);
    }
  } catch (error) {
    setStatus("插件还没有注入当前页面。请刷新 Facebook/Messenger 页面后再点。", true);
  }
}

document.getElementById("save-current").addEventListener("click", () => sendToPage("captureCurrent"));
document.getElementById("scan-visible").addEventListener("click", () => sendToPage("scanVisible"));
document.getElementById("test-config").addEventListener("click", () => sendToPage("testConfig"));
