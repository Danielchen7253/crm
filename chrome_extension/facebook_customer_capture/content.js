(function () {
  const config = window.COOLFIX_CRM_CAPTURE_CONFIG || {};
  const STORAGE_KEY = "coolfix_customer_capture_queue_v2";

  const state = {
    running: false,
    importing: false,
    target: 50,
    queue: [],
    seen: new Set(),
    imported: 0,
    failed: 0,
    message: "准备就绪",
    observer: null,
    debounceTimer: null,
    lastScanAt: null
  };

  function clean(text, limit = 500) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function absoluteUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return "";
    }
  }

  function sourceFromUrl(url) {
    const value = String(url || location.href).toLowerCase();
    if (value.includes("/marketplace/")) return "marketplace";
    if (value.includes("messenger.com") || value.includes("/messages/")) return "private_messenger";
    return "facebook";
  }

  function pageTitle() {
    const og = document.querySelector('meta[property="og:title"]')?.content;
    return clean(og || document.title, 180)
      .replace(/\s*\|\s*Facebook$/i, "")
      .replace(/\s*-\s*Messenger$/i, "")
      .replace(/\s*\(\d+\)\s*$/, "");
  }

  function visibleTextNodes(root) {
    return [...root.querySelectorAll('[data-ad-preview="message"], [dir="auto"], div[role="row"], span')]
      .filter(visible)
      .map((el) => clean(el.innerText || el.textContent, 1000))
      .filter((text) => text.length >= 2 && text.length <= 1000)
      .filter((text) => !/^(like|reply|send|search|home|notifications|messenger|marketplace|facebook)$/i.test(text));
  }

  function extractVisibleMessages(root = document) {
    const texts = visibleTextNodes(root);
    const messages = [];
    const seen = new Set();

    for (const text of texts) {
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push({
        direction: "inbound",
        message_type: "text",
        text,
        sent_at: new Date().toISOString()
      });
      if (messages.length >= 200) break;
    }

    return messages;
  }

  function bestAvatar(root) {
    const candidates = [...root.querySelectorAll("img")]
      .filter(visible)
      .map((img) => {
        const rect = img.getBoundingClientRect();
        const src = img.currentSrc || img.src || "";
        const alt = clean(img.alt, 120);
        const score = Math.min(rect.width, rect.height)
          + (src.includes("fbcdn") || src.includes("fbsbx") ? 80 : 0)
          + (alt ? 20 : 0);
        return { src, score, width: rect.width, height: rect.height };
      })
      .filter((item) => item.src && item.width >= 24 && item.height >= 24 && !item.src.includes("emoji"))
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.src || "";
  }

  function likelyCustomerLink(href) {
    const value = String(href || "").toLowerCase();
    if (!value.includes("facebook.com") && !value.includes("messenger.com")) return false;
    if (value.includes("/groups/") || value.includes("/settings") || value.includes("/help")) return false;
    if (value.includes("/marketplace/you/")) return false;
    if (value.includes("/marketplace/item/")) return true;
    if (value.includes("/messages/") || value.includes("messenger.com/t/")) return true;
    if (value.includes("/profile.php")) return true;
    return /facebook\.com\/[a-z0-9_.-]+\/?(\?|$)/i.test(value);
  }

  function nameFromAnchor(anchor) {
    const text = clean(anchor.innerText || anchor.textContent, 1000);
    const lines = text.split(/\n+/).map((line) => clean(line, 180)).filter(Boolean);
    return lines.find((line) => !/^(sponsored|marketplace|facebook|messenger|active|now|you:|sent|reply)$/i.test(line))
      || lines[0]
      || clean(anchor.getAttribute("aria-label"), 160);
  }

  function bestHeading() {
    const headings = [...document.querySelectorAll("h1,h2,[role='heading']")]
      .filter(visible)
      .map((el) => clean(el.innerText || el.textContent, 180))
      .filter((text) => text && !/facebook|messenger|marketplace|search/i.test(text));
    return headings[0] || "";
  }

  function currentConversationCustomer() {
    const source = sourceFromUrl(location.href);
    if (source !== "private_messenger" && !String(location.href).toLowerCase().includes("/messages/")) return null;

    const messages = extractVisibleMessages(document);
    const name = bestHeading() || pageTitle() || "Facebook Customer";
    if (!name || !messages.length) return null;

    return {
      source,
      display_name: clean(name, 160),
      profile_pic_url: bestAvatar(document),
      profile_url: "",
      conversation_url: location.href,
      thread_url: location.href,
      marketplace_item_url: "",
      page_url: location.href,
      page_title: pageTitle(),
      latest_message: messages[messages.length - 1]?.text || "",
      messages,
      captured_at: new Date().toISOString()
    };
  }

  function extractFromAnchor(anchor) {
    const href = absoluteUrl(anchor.getAttribute("href") || anchor.href || "");
    if (!likelyCustomerLink(href)) return null;

    const name = nameFromAnchor(anchor);
    if (!name || name.length < 2) return null;

    const source = sourceFromUrl(href);
    const text = clean(anchor.innerText || anchor.textContent, 1000);
    const messages = text ? [{
      direction: "inbound",
      message_type: "text",
      text,
      sent_at: new Date().toISOString()
    }] : [];
    return {
      source,
      display_name: clean(name, 160),
      profile_pic_url: bestAvatar(anchor),
      profile_url: href,
      conversation_url: href,
      thread_url: href,
      marketplace_item_url: source === "marketplace" ? href : "",
      page_url: location.href,
      page_title: pageTitle(),
      latest_message: text,
      messages,
      captured_at: new Date().toISOString()
    };
  }

  function customerKey(item) {
    return [
      item.source || "",
      item.profile_url || item.conversation_url || item.thread_url || "",
      (item.display_name || "").toLowerCase()
    ].join("|");
  }

  function scanVisible() {
    const anchors = [...document.querySelectorAll("a[href]")].filter(visible);
    const found = anchors.map(extractFromAnchor).filter(Boolean);
    const current = currentConversationCustomer();
    if (current) found.unshift(current);
    let added = 0;

    for (const item of found) {
      const key = customerKey(item);
      if (!key || state.seen.has(key)) continue;
      state.seen.add(key);
      state.queue.push(item);
      added += 1;
      if (state.queue.length >= state.target) break;
    }

    state.lastScanAt = new Date().toISOString();
    if (added) {
      state.message = `已抓到 ${state.queue.length}/${state.target} 个客户`;
      saveQueue();
    } else if (state.running) {
      state.message = `监听中，已抓到 ${state.queue.length}/${state.target} 个客户`;
    }

    if (state.running && state.queue.length >= state.target && !state.importing) {
      state.message = `已抓够 ${state.target} 个，正在上传 CRM`;
      uploadAndClear();
    }

    return { found: found.length, added };
  }

  function scheduleScan() {
    if (!state.running || state.importing) return;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(scanVisible, 350);
  }

  function startWatching(target = 50) {
    if (state.running) return progress();
    state.target = Math.max(1, Math.min(Number(target || 50), 500));
    state.queue = [];
    state.seen = new Set();
    state.imported = 0;
    state.failed = 0;
    state.running = true;
    state.importing = false;
    state.message = `采集中：请滚动客户列表，目标 ${state.target} 个`;

    window.addEventListener("scroll", scheduleScan, true);
    state.observer = new MutationObserver(scheduleScan);
    state.observer.observe(document.body, { childList: true, subtree: true });

    scanVisible();
    saveQueue();
    return progress();
  }

  function stopWatching() {
    state.running = false;
    window.removeEventListener("scroll", scheduleScan, true);
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    clearTimeout(state.debounceTimer);
  }

  async function submit(customers) {
    if (!config.crmUrl || !config.captureToken || config.captureToken.includes("PUT_")) {
      throw new Error("插件缺少 CRM 地址或导入口令，请检查 config.js。");
    }
    const body = customers.length === 1 ? customers[0] : { customers };
    const response = await fetch(`${config.crmUrl.replace(/\/$/, "")}/api/capture/facebook-customer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CRM-Capture-Token": config.captureToken
      },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "CRM 保存失败。");
    }
    return data;
  }

  async function uploadAndClear() {
    if (state.importing) return progress();
    stopWatching();
    if (!state.queue.length) {
      state.message = "没有抓到客户，请先滚动客户列表";
      return progress();
    }

    state.importing = true;
    state.message = `正在上传 ${state.queue.length} 个客户到 CRM`;
    await saveQueue();

    try {
      const data = await submit(state.queue);
      state.imported = Number(data.saved || state.queue.length);
      state.failed = Math.max(0, state.queue.length - state.imported);
      state.message = `上传完成：${state.imported} 个客户已进入 CRM，本地队列已清空`;
      state.queue = [];
      state.seen = new Set();
    } catch (error) {
      state.failed = state.queue.length;
      state.message = `上传失败：${error.message || error}`;
    } finally {
      state.importing = false;
      await saveQueue();
    }

    return progress();
  }

  async function saveQueue() {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        queue: state.queue,
        imported: state.imported,
        failed: state.failed,
        target: state.target,
        message: state.message,
        savedAt: new Date().toISOString()
      }
    });
  }

  async function loadQueue() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const saved = data[STORAGE_KEY] || {};
    if (!state.running && !state.importing) {
      state.queue = Array.isArray(saved.queue) ? saved.queue : [];
      state.seen = new Set(state.queue.map(customerKey));
      state.imported = Number(saved.imported || 0);
      state.failed = Number(saved.failed || 0);
      state.target = Number(saved.target || 50);
      state.message = state.queue.length ? `本地还有 ${state.queue.length} 个未上传客户` : "准备就绪";
    }
    return progress();
  }

  function progress() {
    return {
      ok: true,
      running: state.running,
      importing: state.importing,
      queued: state.queue.length,
      imported: state.imported,
      failed: state.failed,
      target: state.target,
      remaining: Math.max(0, state.target - state.queue.length),
      message: state.message,
      lastScanAt: state.lastScanAt
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message.action === "status") {
        await loadQueue();
        sendResponse(progress());
        return;
      }
      if (message.action === "startWatching") {
        sendResponse(startWatching(message.target || 50));
        return;
      }
      if (message.action === "scanNow") {
        const result = scanVisible();
        sendResponse({ ...progress(), ...result });
        return;
      }
      if (message.action === "uploadAndClear") {
        const result = await uploadAndClear();
        sendResponse(result);
        return;
      }
      if (message.action === "stop") {
        stopWatching();
        state.message = `已停止采集，当前 ${state.queue.length} 个客户`;
        await saveQueue();
        sendResponse(progress());
      }
    })().catch((error) => sendResponse({ ok: false, error: error.message || String(error), ...progress() }));
    return true;
  });

  loadQueue();
})();
