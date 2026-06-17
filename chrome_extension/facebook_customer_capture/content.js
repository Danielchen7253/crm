(function () {
  if (window.__COOLFIX_CRM_CUSTOMER_CAPTURE_LOADED__) return;
  window.__COOLFIX_CRM_CUSTOMER_CAPTURE_LOADED__ = true;

  const config = window.COOLFIX_CRM_CAPTURE_CONFIG || {};
  const JOB_KEY = "coolfix_customer_sequential_capture_v2";
  let processing = false;
  let lastUrl = location.href;
  let processingStartedAt = 0;

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

  function comparableUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/$/, "")}`;
    } catch {
      return String(url || "").split("?")[0].split("#")[0].replace(/\/$/, "");
    }
  }

  function sourceFromUrl(url) {
    const value = String(url || location.href).toLowerCase();
    if (value.includes("/marketplace/")) return "marketplace";
    if (value.includes("messenger.com") || value.includes("/messages/")) return "private_messenger";
    return "facebook";
  }

  function currentMode() {
    const value = String(location.href || "").toLowerCase();
    if (value.includes("messenger.com") || value.includes("/messages/")) return "messenger";
    if (value.includes("/marketplace/")) return "marketplace";
    return "facebook";
  }

  function pageTitle() {
    const og = document.querySelector('meta[property="og:title"]')?.content;
    return clean(og || document.title, 180)
      .replace(/\s*\|\s*Facebook$/i, "")
      .replace(/\s*-\s*Messenger$/i, "")
      .replace(/\s*\(\d+\)\s*$/, "");
  }

  function isMessengerThreadLink(href) {
    const value = String(href || "").toLowerCase();
    return value.includes("messenger.com/t/")
      || value.includes("facebook.com/messages/t/")
      || value.includes("/messages/t/")
      || value.includes("/messages/e2ee/t/");
  }

  function likelyCustomerLink(href, mode = currentMode()) {
    const value = String(href || "").toLowerCase();
    if (!value.includes("facebook.com") && !value.includes("messenger.com")) return false;
    if (value.includes("/groups/") || value.includes("/settings") || value.includes("/help")) return false;
    if (value.includes("/notifications") || value.includes("/watch") || value.includes("/reel/")) return false;

    if (mode === "messenger") return isMessengerThreadLink(value);
    if (mode === "marketplace") {
      if (isMessengerThreadLink(value)) return true;
      if (value.includes("/messages/")) return true;
      return false;
    }
    return isMessengerThreadLink(value) || value.includes("/messages/");
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

  function customerItemKey(item) {
    return `${item.source || ""}|${comparableUrl(item.url || item.profile_url || item.conversation_url || "")}`;
  }

  function collectVisibleCustomerLinks(excludeKeys = new Set()) {
    const local = new Set();
    const links = [];
    const mode = currentMode();
    for (const anchor of [...document.querySelectorAll("a[href]")].filter(visible)) {
      const item = linkFromAnchor(anchor);
      if (!item) continue;
      if (mode === "messenger" && !isMessengerThreadLink(item.url)) continue;
      const key = customerItemKey(item);
      if (excludeKeys.has(key) || local.has(key)) continue;
      local.add(key);
      links.push(item);
    }
    return links;
  }

  function scrollCustomerList() {
    const candidates = [...document.querySelectorAll("div, main, section")]
      .filter(visible)
      .map((el) => {
        const anchors = [...el.querySelectorAll("a[href]")].filter((anchor) => {
          const href = absoluteUrl(anchor.getAttribute("href") || anchor.href || "");
          return likelyCustomerLink(href);
        });
        const rect = el.getBoundingClientRect();
        return {
          el,
          anchorCount: anchors.length,
          overflow: el.scrollHeight - el.clientHeight,
          area: rect.width * rect.height
        };
      })
      .filter((item) => item.anchorCount > 2 && item.overflow > 80)
      .sort((a, b) => (b.anchorCount * 5000 + b.overflow + b.area / 1000) - (a.anchorCount * 5000 + a.overflow + a.area / 1000));

    const target = candidates[0]?.el;
    if (target) {
      target.scrollTop += Math.max(420, Math.floor(target.clientHeight * 0.75));
      target.dispatchEvent(new Event("scroll", { bubbles: true }));
      return true;
    }
    window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.7)));
    return false;
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
        const hints = (text.match(/reply|sent|message|active|today|yesterday|you:/gi) || []).length;
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
      await sleep(800);
      return;
    }
    for (let i = 0; i < 4; i += 1) {
      target.scrollTop = 0;
      target.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(900);
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
    await sleep(1600);
    await loadMoreMessages();
    await sleep(500);

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
      throw new Error("Extension config.js is missing CRM URL or capture token.");
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
      throw new Error(data.error || "CRM save failed.");
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
      skipped: 0,
      stagnantRounds: 0,
      processedKeys: [],
      message: "Ready"
    };
  }

  async function setJob(job) {
    await chrome.storage.local.set({ [JOB_KEY]: job });
  }

  function jobExcludeSet(job) {
    const exclude = new Set(Array.isArray(job.processedKeys) ? job.processedKeys : []);
    for (const item of job.queue || []) exclude.add(customerItemKey(item));
    return exclude;
  }

  async function refillQueue(job) {
    const more = collectVisibleCustomerLinks(jobExcludeSet(job));
    if (more.length) {
      job.queue.push(...more);
      job.stagnantRounds = 0;
      job.updatedAt = new Date().toISOString();
      job.message = `Added ${more.length} more customers. Queue ${job.index}/${job.queue.length}.`;
      await setJob(job);
      await sleep(400);
      await goNext(job);
      return true;
    }

    job.stagnantRounds = (job.stagnantRounds || 0) + 1;
    job.updatedAt = new Date().toISOString();
    job.message = `No new customers. Scrolling list ${job.stagnantRounds}/10.`;
    await setJob(job);

    if (job.listUrl && comparableUrl(location.href) !== comparableUrl(job.listUrl) && job.stagnantRounds <= 2) {
      location.href = job.listUrl;
      return true;
    }

    scrollCustomerList();
    setTimeout(processCurrentPageIfNeeded, 2000);
    return job.stagnantRounds < 10;
  }

  async function goNext(job) {
    if (!job.running) return;
    if (job.index >= job.queue.length) {
      const refilled = await refillQueue(job);
      if (refilled) return;
      job.running = false;
      job.message = `Finished. Uploaded ${job.saved}, failed ${job.failed}, skipped ${job.skipped || 0}.`;
      await setJob(job);
      return;
    }

    const next = job.queue[job.index];
    const key = customerItemKey(next);
    job.processedKeys = Array.isArray(job.processedKeys) ? job.processedKeys : [];
    if (job.processedKeys.includes(key)) {
      job.skipped = (job.skipped || 0) + 1;
      job.index += 1;
      await setJob(job);
      await goNext(job);
      return;
    }

    job.message = `Opening ${job.index + 1}/${job.queue.length}: ${next.display_name || "customer"}`;
    job.openingIndex = job.index;
    job.openingAttempts = (job.openingAttempts || 0) + 1;
    job.updatedAt = new Date().toISOString();
    await setJob(job);
    if (job.openingAttempts > 3) {
      job.failed += 1;
      job.index += 1;
      job.openingAttempts = 0;
      job.message = `Skipped stuck customer: ${next.display_name || "customer"}`;
      await setJob(job);
      await goNext(job);
      return;
    }
    if (comparableUrl(location.href) === comparableUrl(next.url)) {
      setTimeout(processCurrentPageIfNeeded, 1000);
      return;
    }
    location.href = next.url;
  }

  async function processCurrentPageIfNeeded() {
    if (processing) return;
    const job = await getJob();
    if (!job.running || !Array.isArray(job.queue)) return;
    if (job.index >= job.queue.length) {
      await goNext(job);
      return;
    }

    const current = job.queue[job.index];
    if (!current) return;

    if (comparableUrl(location.href) !== comparableUrl(current.url)) {
      const ageMs = Date.now() - Date.parse(job.updatedAt || job.startedAt || new Date().toISOString());
      if (ageMs > 7000) await goNext(job);
      return;
    }

    processing = true;
    processingStartedAt = Date.now();
    job.message = `Capturing ${job.index + 1}/${job.queue.length}: ${current.display_name || "customer"}`;
    job.updatedAt = new Date().toISOString();
    job.openingAttempts = 0;
    await setJob(job);

    try {
      const customer = await captureCurrentCustomer(current);
      const result = await submit(customer);
      job.saved += Number(result.saved || 1);
      job.processedKeys = Array.isArray(job.processedKeys) ? job.processedKeys : [];
      const key = customerItemKey(current);
      if (!job.processedKeys.includes(key)) job.processedKeys.push(key);
      job.message = `Uploaded: ${customer.display_name}`;
    } catch (error) {
      job.failed += 1;
      job.message = `Failed: ${error.message || error}`;
    } finally {
      processing = false;
      processingStartedAt = 0;
    }

    job.index += 1;
    job.updatedAt = new Date().toISOString();
    await setJob(job);
    await sleep(800);
    await goNext(job);
  }

  async function startSequentialCapture() {
    const queue = collectVisibleCustomerLinks();
    if (!queue.length) {
      return { ok: false, error: "No customer chat links found on this screen. Open the customer list first." };
    }
    const job = {
      running: true,
      queue,
      index: 0,
      saved: 0,
      failed: 0,
      skipped: 0,
      stagnantRounds: 0,
      listUrl: location.href,
      processedKeys: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      message: `Queued ${queue.length} customers. Starting capture.`
    };
    await setJob(job);
    await sleep(400);
    await goNext(job);
    return statusFromJob(job);
  }

  async function stopSequentialCapture() {
    const job = await getJob();
    job.running = false;
    job.message = `Stopped. Uploaded ${job.saved || 0}. Position ${job.index || 0}/${(job.queue || []).length}.`;
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
      skipped: job.skipped || 0,
      message: job.message || "Ready"
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
        sendResponse({ ok: true, saved: result.saved || 1, message: `Uploaded: ${customer.display_name}` });
      }
    })().catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });

  async function skipStuckCustomer(reason) {
    const job = await getJob();
    if (!job.running || !Array.isArray(job.queue) || job.index >= job.queue.length) return;
    const current = job.queue[job.index];
    job.failed += 1;
    job.index += 1;
    job.openingAttempts = 0;
    job.updatedAt = new Date().toISOString();
    job.message = `Skipped stuck customer: ${current?.display_name || "customer"} (${reason})`;
    processing = false;
    processingStartedAt = 0;
    await setJob(job);
    await goNext(job);
  }

  async function watchJob() {
    if (processing && processingStartedAt && Date.now() - processingStartedAt > 25000) {
      await skipStuckCustomer("timeout");
      return;
    }
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(processCurrentPageIfNeeded, 1200);
    }
    await processCurrentPageIfNeeded();
  }

  processCurrentPageIfNeeded();
  setInterval(watchJob, 2500);
})();
