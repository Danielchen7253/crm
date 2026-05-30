const $ = (id) => document.getElementById(id);

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function render(state) {
  if (!state || !state.ok) {
    $("postTitle").textContent = "CRM 未连接";
    $("groupName").textContent = "";
    $("status").textContent = state && state.error ? state.error : "Open CRM and log in first.";
    return;
  }
  $("postTitle").textContent = state.post ? state.post.title || "未命名文案" : "没有文案";
  $("groupName").textContent = state.current_group ? state.current_group.name : "没有群组";
  $("status").textContent = `队列：${state.groups.length} 个群组\n当前：${state.current_group ? state.current_group.url : "无"}`;
}

async function refresh() {
  render(await send({ type: "getState" }));
}

$("start").addEventListener("click", async () => {
  const state = await send({ type: "openCurrentGroup" });
  render(state);
});

$("refresh").addEventListener("click", refresh);
refresh();
