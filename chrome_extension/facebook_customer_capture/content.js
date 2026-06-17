(function () {
  if (window.__COOLFIX_CRM_CUSTOMER_CAPTURE_LOADED__) {
    return;
  }
  window.__COOLFIX_CRM_CUSTOMER_CAPTURE_LOADED__ = true;

  const config = window.COOLFIX_CRM_CAPTURE_CONFIG || {};
  const JOB_KEY = "coolfix_customer_sequential_capture_v1";

  function clean(text, limit = 500) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  function likelyCustomerLink(href) {
    const value = String(href || "").toLowerCase();
    if (!value.includes("facebook.com") && !value.includes("messenger.com")) return false;
    if (value.includes("/groups/") || value.includes("/settings") || value.includes("/help")) return false;
    if (value.includes("/notifications") || value.includes("/watch") || value.includes("/reel/")) return false;
    if (value.includes("/marketplace/you/")) return false;
    if (value.includes("/messages/") || value.includes("messenger.com/t/")) return true;
    if (value.includes("/marketplace/item/")) return true;
    if (value.includes("/profile.php")) return true;
    return /facebook\.com\/[a-z0-9_.-]+\/?(\?|$)/i.test(value);
  }

  function bestAvatar(root = document) {
    const candidates = [...root.querySelectorAll("img")]
      .filter(visible)
      .map((img) => {
        const rect = img.getBoundingClientRect();
        const src = img.currentSrc || img.src || "";
        const score = Math.min(rect.width, rect.height)
          + (src.includes("fbcdn") || src.includes("fbsbx") ? 80 : 0)
          + (clean(img.alt, 80) ? 20 : 0);
        return { src, score, width: rect.width, height: rect.height };
      })
      .filter((item) => item.src && item.width >= 24 && item.height >= 24 && !item.src.includes("emoji"))
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.src || "";
  }

  function nameFromAnchor(anchor) {
    const text = clean(anchor.innerText || anchor.textContent, 1000);
    const lines = text.split(/\n+/).map((line) => clean(line, 180)).filter(Boolean);
    return lines.find((line) => !/^(sponsored|marketplace|facebook|messenger|active|now|you:|sent|reply)$/i.test(line))
      || lines[0]
      || clean(anchor.getAttribute("aria-label"), 160);
  }

  function linkFromAnchor(anchor) {
    const href = absoluteUrl(anchor.getAttribute("href") || anchor.href || "");
    if (!likelyCustomerLink(href)) return null;
    const name = nameFromAnchor(anchor);
    if (!name || name.length < 2) return null;
    return {
      url: href,
      display_name: clean(name, 160),
      profile_pic_url: bestAvatar(anchor),
      latest_message: clean(anchor.innerText || anchor.textContent, 1000),
      source: sourceFromUrl(href)
    };
  }

  function collectVisibleCustomerLinks() {
    const seen = new Set();
    const links = [];
    for (const anchor of [...document.querySelectorAll("a[href]")].filter(visible)) {
      const item = linkFromAnchor(anchor);
      if (!item) continue;
      const key = `${item.source}|${item.url}|${item.display_name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(item);
      if (links.length >= 100) break;
    }
    return links;
  }

  function bestHeading() {
    const headings = [...document.querySelectorAll("h1,h2,[role='heading']")]
      .filter(visible)
      .map((el) => clean(el.innerText || el.textContent, 180))
      .filter((text) => text && !/facebook|messenger|marketplace|search/i.test(text));
    return headings[0] || "";
  }

  function messageContainer() {
    const viewportArea = window.innerWidth * window.innerHeight;
    const candidates = [...document.querySelectorAll("div, main, section")]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const overflow = el.scrollHeight - el.clientHeight;
        const area = rect.width * rect.height;
        const text = clean(el.innerText || "", 2200);
        const hints = (text.match(/reply|sent|message|active|today|yesterday|you:|上午|下午|回复|发送/gi) || []).length;
        return { el, overflow, area, hints };
      })
      .filter((item) => item.overflow > 80 && item.area > viewportArea * 0.05)
      .sort((a, b) => (b.hints * 4000 + b.overflow + b.area / 1000) - (a.hints * 4000 + a.overflow + a.area / 1000));
    return candidates[0]?.el || null;
  }

  async function loadMoreMessages() {
    const target = messageContainer();
    if (!target) {
      window.scrollTo(0, 0);
      await sleep(1000);
      return;
    }
    for (let i = 0; i < 5; i += 1) {
      target.scrollTop = 0;
      target.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(1200);
    }
  }

  function extractMessages() {
    const texts = [...document.querySelectorAll('[data-ad-preview="message"], [dir="auto"], div[role="row"], span')]
      .filter(visible)
      .map((el) => clean(el.innerText || el.textContent, 1000))
      .filter((text) => text.length >= 2 && text.length <= 1000)
      .filter((text) => !/^(like|reply|send|search|home|notifications|messenger|marketplace|facebook)$/i.test(text));

    const seen = new Set();
    const messages = [];
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

  async function captureCurrentCustomer(seed = {}) {
    await sleep(2500);
    await loadMoreMessages();
    await sleep(800);

    const messages = extractMessages();
    const source = sourceFromUrl(location.href);
    const displayName = bestHeading() || seed.display_name || pageTitle() || "Facebook Customer";
    return {
      source,
      display_name: clean(displayName, 160),
      profile_pic_url: bestAvatar(document) || seed.profile_pic_url || "",
      profile_url: seed.url || "",
      conversation_url: location.href,
      thread_url: location.href,
      marketplace_item_url: source === "marketplace" ? location.href : "",
      page_url: location.href,
      page_title: pageTitle(),
      latest_message: messages[messages.length - 1]?.text || seed.latest_message || "",
      messages,
      captured_at: new Date().toISOString()
    };
  }

  async function submit(customer) {
    if (!config.crmUrl || !config.captureToken || config.captureToken.includes("PUT_")) {
      throw new Error("插件缺少 CRM 地址或导入口令，请检查 config.js。");
    }
    const response = await fetch(`${config.crmUrl.replace(/\/$/, "")}/api/capture/facebook-customer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CRM-Capture-Token": config.captureToken
      },
      body: JSON.stringify(customer)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "CRM 保存失败。");
    }
    return data;
  }

  async function getJob() {
    const data = await chrome.storage.local.get(JOB_KEY);
    return data[JOB_KEY] || {
      running: false,
      queue: [],
      index: 0,
      saved: 0,
      failed: 0,
      message: "准备就绪"
    };
  }

  async function setJob(job) {
    await chrome.storage.local.set({ [JOB_KEY]: job });
  }

  async function goNext(job) {
    if (!job.running) return;
    if (job.index >= job.queue.length) {
      job.running = false;
      job.message = `完成：已上传 ${job.saved} 个，失败 ${job.failed} 个`;
      await setJob(job);
      return;
    }
    const next = job.queue[job.index];
    job.message = `打开第 ${job.index + 1}/${job.queue.length} 个客户`;
    await setJob(job);
    location.href = next.url;
  }

  async function processCurrentPageIfNeeded() {
    const job = await getJob();
    if (!job.running || !Array.isArray(job.queue) || job.index >= job.queue.length) return;

    const current = job.queue[job.index];
    if (!current || location.href.split("#")[0] !== String(current.url || "").split("#")[0]) return;

    job.message = `采集第 ${job.index + 1}/${job.queue.length} 个客户资料和聊天记录`;
    await setJob(job);

    try {
      const customer = await captureCurrentCustomer(current);
      const result = await submit(customer);
      job.saved += Number(result.saved || 1);
      job.message = `已上传：${customer.display_name}`;
    } catch (error) {
      job.failed += 1;
      job.message = `失败：${error.message || error}`;
    }

    job.index += 1;
    await setJob(job);
    await sleep(1500);
    await goNext(job);
  }

  async function startSequentialCapture() {
    const queue = collectVisibleCustomerLinks();
    if (!queue.length) {
      return { ok: false, error: "当前屏幕没有识别到客户链接。请先打开客户列表页。" };
    }
    const job = {
      running: true,
      queue,
      index: 0,
      saved: 0,
      failed: 0,
      startedAt: new Date().toISOString(),
      message: `已建立 ${queue.length} 个客户队列，准备逐个采集`
    };
    await setJob(job);
    await sleep(500);
    await goNext(job);
    return statusFromJob(job);
  }

  async function stopSequentialCapture() {
    const job = await getJob();
    job.running = false;
    job.message = `已停止：已上传 ${job.saved || 0} 个，当前位置 ${job.index || 0}/${(job.queue || []).length}`;
    await setJob(job);
    return statusFromJob(job);
  }

  function statusFromJob(job) {
    return {
      ok: true,
      running: Boolean(job.running),
      total: (job.queue || []).length,
      index: job.index || 0,
      saved: job.saved || 0,
      failed: job.failed || 0,
      message: job.message || "准备就绪"
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message.action === "status") {
        sendResponse(statusFromJob(await getJob()));
        return;
      }
      if (message.action === "startSequentialCapture") {
        sendResponse(await startSequentialCapture());
        return;
      }
      if (message.action === "stopSequentialCapture") {
        sendResponse(await stopSequentialCapture());
        return;
      }
      if (message.action === "captureCurrentOnly") {
        const customer = await captureCurrentCustomer({});
        const result = await submit(customer);
        sendResponse({ ok: true, saved: result.saved || 1, message: `已上传：${customer.display_name}` });
      }
    })().catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });

  processCurrentPageIfNeeded();
})();
