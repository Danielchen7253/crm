let state = null;

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function setStatus(text) {
  const el = document.querySelector("#coolfix-crm-assistant .cf-status");
  if (el) el.textContent = text;
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function findClickableComposer() {
  const candidates = [...document.querySelectorAll('div[role="button"], span, div')];
  return candidates.find((el) => {
    const text = normalizeText(el.innerText || el.textContent || "");
    return text.includes("write something") || text.includes("create public post") || text.includes("what's on your mind") || text.includes("写点") || text.includes("创建帖子");
  });
}

async function waitForTextbox() {
  for (let i = 0; i < 30; i += 1) {
    const boxes = [...document.querySelectorAll('div[contenteditable="true"][role="textbox"], div[contenteditable="true"]')];
    const box = boxes.find((el) => el.offsetParent !== null);
    if (box) return box;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function fillPostText(text) {
  const opener = findClickableComposer();
  if (opener) opener.click();
  const box = await waitForTextbox();
  if (!box) {
    setStatus("没有找到 Facebook 发帖输入框。先手动点一下发帖框，再点“填入贴文”。");
    return;
  }
  box.focus();
  document.execCommand("selectAll", false, null);
  document.execCommand("insertText", false, text);
  box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  setStatus("贴文已填入。图片/视频请用下方按钮打开后手动上传，最后你自己点发布。");
}

async function copyText(text) {
  await navigator.clipboard.writeText(text || "");
  setStatus("贴文已复制。");
}

async function markPosted() {
  if (!state || !state.current_group || !state.post) return;
  const next = await send({ type: "markPosted", groupId: state.current_group.id, postId: state.post.id });
  if (!next.ok) {
    setStatus(next.error || "标记失败");
    return;
  }
  state = next;
  setStatus("已标记，正在打开下一个群组。");
}

function render() {
  if (document.getElementById("coolfix-crm-assistant")) return;
  const panel = document.createElement("div");
  panel.id = "coolfix-crm-assistant";
  panel.innerHTML = `
    <h2>Coolfix 发帖助手</h2>
    <div class="cf-muted" id="cf-group"></div>
    <div class="cf-muted" id="cf-post"></div>
    <div class="cf-preview" id="cf-text"></div>
    <div id="cf-media"></div>
    <button id="cf-fill">填入贴文</button>
    <button class="cf-secondary" id="cf-copy">复制贴文</button>
    <a class="cf-secondary" id="cf-image" target="_blank" rel="noopener">打开图片</a>
    <a class="cf-secondary" id="cf-video" target="_blank" rel="noopener">打开视频</a>
    <button id="cf-mark">已发布，打开下一个</button>
    <button class="cf-secondary" id="cf-refresh">刷新</button>
    <div class="cf-status"></div>
  `;
  document.body.appendChild(panel);
  panel.querySelector("#cf-fill").addEventListener("click", () => fillPostText(state?.post?.content || ""));
  panel.querySelector("#cf-copy").addEventListener("click", () => copyText(state?.post?.content || ""));
  panel.querySelector("#cf-mark").addEventListener("click", markPosted);
  panel.querySelector("#cf-refresh").addEventListener("click", loadState);
}

function updatePanel() {
  render();
  if (!state || !state.ok) {
    setStatus(state?.error || "CRM 未连接。先登录 CRM，再刷新。");
    return;
  }
  document.getElementById("cf-group").textContent = state.current_group ? `当前群组：${state.current_group.name}` : "没有当前群组";
  document.getElementById("cf-post").textContent = state.post ? `样板：${state.post.title}` : "没有发帖样板";
  document.getElementById("cf-text").textContent = state.post?.content || "";
  const media = document.getElementById("cf-media");
  media.innerHTML = "";
  if (state.post?.image_url) {
    const img = document.createElement("img");
    img.src = state.post.image_url;
    media.appendChild(img);
  }
  if (state.post?.video_url) {
    const video = document.createElement("video");
    video.src = state.post.video_url;
    video.controls = true;
    video.muted = true;
    media.appendChild(video);
  }
  const image = document.getElementById("cf-image");
  const video = document.getElementById("cf-video");
  image.href = state.post?.image_url || "#";
  video.href = state.post?.video_url || "#";
  image.style.display = state.post?.image_url ? "block" : "none";
  video.style.display = state.post?.video_url ? "block" : "none";
  setStatus("如果你还没加入这个群，先点 Facebook 的加入。加入后点“填入贴文”，最后你自己点发布。");
}

async function loadState() {
  state = await send({ type: "getState" });
  updatePanel();
}

loadState();
