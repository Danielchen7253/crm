let state = null;

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function setStatus(text) {
  const el = document.querySelector("#coolfix-crm-assistant .cf-status");
  if (el) el.textContent = text;
}

function visible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function findByText(selector, keywords) {
  return [...document.querySelectorAll(selector)].find((el) => {
    if (!visible(el)) return false;
    const text = normalizeText(el.innerText || el.textContent || el.getAttribute("aria-label") || "");
    return keywords.some((keyword) => text.includes(keyword));
  });
}

function findClickableComposer() {
  return findByText('div[role="button"], span[role="button"], button, div[aria-label], span', [
    "write something",
    "create public post",
    "create post",
    "what's on your mind",
    "写点",
    "创建帖子",
    "发帖"
  ]);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTextbox() {
  for (let i = 0; i < 40; i += 1) {
    const boxes = [...document.querySelectorAll('div[contenteditable="true"][role="textbox"], div[contenteditable="true"], textarea')];
    const box = boxes.reverse().find((el) => visible(el) && !el.closest("#coolfix-crm-assistant"));
    if (box) return box;
    await sleep(250);
  }
  return null;
}

function selectContenteditable(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

async function writeIntoTextbox(box, text) {
  box.focus();
  await sleep(120);
  if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") {
    box.value = text;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  selectContenteditable(box);
  let inserted = document.execCommand("insertText", false, text);
  if (!inserted || normalizeText(box.innerText) !== normalizeText(text)) {
    try {
      await navigator.clipboard.writeText(text);
      inserted = document.execCommand("paste", false, null);
    } catch (error) {
      inserted = false;
    }
  }
  if (!inserted || !normalizeText(box.innerText).includes(normalizeText(text).slice(0, 40))) {
    box.textContent = text;
  }
  box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: text }));
  box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: " " }));
}

async function fillPostText(text) {
  if (!text) {
    setStatus("没有贴文内容。");
    return;
  }
  const opener = findClickableComposer();
  if (opener) {
    opener.click();
    await sleep(900);
  }
  let box = await waitForTextbox();
  if (!box) {
    await navigator.clipboard.writeText(text);
    setStatus("没找到 Facebook 发帖输入框，已先复制贴文。请手动点发帖输入框后 Ctrl+V。");
    return;
  }
  await writeIntoTextbox(box, text);
  await navigator.clipboard.writeText(text);
  setStatus("已尝试填入贴文，同时已复制到剪贴板。如果 Facebook 没显示文字，直接在输入框 Ctrl+V。");
}

async function copyText(text) {
  await navigator.clipboard.writeText(text || "");
  setStatus("贴文已复制。");
}

function findExistingFileInput() {
  const inputs = [...document.querySelectorAll('input[type="file"]')].reverse();
  return inputs.find((input) => {
    const accept = (input.getAttribute("accept") || "").toLowerCase();
    return accept.includes("image") || accept.includes("video") || accept.includes("media") || !accept;
  });
}

async function openMediaPicker() {
  const mediaButton = findByText('div[role="button"], span[role="button"], button, div[aria-label]', [
    "photo/video",
    "photo",
    "video",
    "照片",
    "图片",
    "视频",
    "相片"
  ]);
  if (mediaButton) {
    mediaButton.click();
    await sleep(800);
  }
  const input = findExistingFileInput();
  if (input) {
    input.click();
    setStatus("已打开电脑文件选择窗口。选择图片或视频后，再手动发布。");
    return;
  }
  setStatus("没有找到上传入口。请先手动点 Facebook 的“照片/视频”，然后再试一次。");
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
    <button id="cf-upload">上传图片/视频</button>
    <button class="cf-secondary" id="cf-copy">复制贴文</button>
    <button id="cf-mark">已发布，打开下一个</button>
    <button class="cf-secondary" id="cf-refresh">刷新</button>
    <div class="cf-status"></div>
  `;
  document.body.appendChild(panel);
  panel.querySelector("#cf-fill").addEventListener("click", () => fillPostText(state?.post?.content || ""));
  panel.querySelector("#cf-upload").addEventListener("click", openMediaPicker);
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
  setStatus("如果你还没加入这个群，先点 Facebook 的加入。加入后点“填入贴文”，再点“上传图片/视频”，最后你自己点发布。");
}

async function loadState() {
  state = await send({ type: "getState" });
  updatePanel();
}

loadState();
