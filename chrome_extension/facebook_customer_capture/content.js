(function () {
  const config = window.COOLFIX_CRM_CAPTURE_CONFIG || {};
  const STORAGE_KEY = "coolfix_customer_capture_queue_v1";

  const state = {
    queue: [],
    seen: new Set(),
    scanning: false,
    importing: false,
    paused: false,
    stopRequested: false,
    imported: 0,
    failed: 0,
    duplicateInPage: 0,
    scanRounds: 0,
    stagnantRounds: 0,
    message: "Ready",
    startedAt: null,
    importStartedAt: null
  };

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

  function customerKey(item) {
    return [
      item.source || "",
      item.profile_url || item.conversation_url || item.thread_url || "",
      (item.display_name || "").toLowerCase()
    ].join("|");
  }

  function bestHeading() {
    const headings = [...document.querySelectorAll("h1,h2,[role='heading']")]
      .filter(visible)
      .map((el) => clean(el.innerText || el.textContent, 180))
      .filter((text) => text && !/facebook|messenger|marketplace|search/i.test(text));
    return headings[0] || "";
  }

  function bestAvatar(root = document) {
    const candidates = [...root.querySelectorAll("img")]
      .filter(visible)
      .map((img) => {
        const rect = img.getBoundingClientRect();
        const src = img.currentSrc || img.src || "";
        const score = Math.min(rect.width, rect.height) + (src.includes("fbcdn") || src.includes("fbsbx") ? 60 : 0);
        return { src, score, width: rect.width, height: rect.height };
      })
      .filter((item) => item.src && item.width >= 24 && item.height >= 24 && !item.src.includes("emoji"))
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.src || "";
  }

  function currentCustomer() {
    const title = pageTitle();
    const source = sourceFromUrl(location.href);
    const name = bestHeading() || title || "Facebook Customer";
    return {
      source,
      display_name: clean(name, 160),
      profile_pic_url: bestAvatar(),
      profile_url: "",
      conversation_url: location.href,
      thread_url: location.href,
      marketplace_item_url: source === "marketplace" ? location.href : "",
      page_url: location.href,
      page_title: title,
      latest_message: latestVisibleMessage(document),
      captured_at: new Date().toISOString()
    };
  }

  function latestVisibleMessage(root) {
    const texts = [...root.querySelectorAll('[data-ad-preview="message"], [dir="auto"], div[role="row"], span')]
      .filter(visible)
      .map((el) => clean(el.innerText || el.textContent, 500))
      .filter((text) => text.length >= 2 && text.length <= 500)
      .filter((text) => !/^(like|reply|send|search|home|notifications|messenger|marketplace)$/i.test(text));
    return texts.slice(-6).join(" | ").slice(0, 1000);
  }

  function likelyCustomerLink(href) {
    const value = String(href || "").toLowerCase();
    if (!value.includes("facebook.com") && !value.includes("messenger.com")) return false;
    if (value.includes("/groups/") || value.includes("/settings") || value.includes("/help")) return false;
    if (value.includes("/marketplace/item/")) return true;
    if (value.includes("/marketplace/you/selling")) return false;
    if (value.includes("/messages/") || value.includes("messenger.com/t/")) return true;
    if (/facebook\.com\/(profile\.php\?id=|[A-Za-z0-9_.-]+\/?$)/.test(value)) return true;
    return value.includes("/profile.php") || value.includes("facebook.com/");
  }

  function extractFromAnchor(anchor) {
    const text = clean(anchor.innerText || anchor.textContent, 1000);
    const lines = text.split(/\n+/).map((part) => clean(part, 180)).filter(Boolean);
    const name = lines.find((part) => !/^(sponsored|marketplace|facebook|messenger|active|now|you:|sent)$/i.test(part)) || lines[0] || "";
    const href = anchor.href || "";
    const source = sourceFromUrl(href || location.href);
    if (!name || name.length < 2 || !likelyCustomerLink(href)) return null;
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
      latest_message: lines.slice(0, 6).join(" | "),
      captured_at: new Date().toISOString()
    };
  }

  function visibleListCustomers() {
    const items = [...document.querySelectorAll("a[href]")]
      .filter(visible)
      .map(extractFromAnchor)
      .filter(Boolean);
    const unique = [];
    const localSeen = new Set();
    for (const item of items) {
      const key = customerKey(item);
      if (localSeen.has(key)) continue;
      localSeen.add(key);
      unique.push(item);
    }
    return unique;
  }

  function addToQueue(items) {
    let added = 0;
    for (const item of items) {
      const key = customerKey(item);
      if (!key || state.seen.has(key)) {
        state.duplicateInPage += 1;
        continue;
      }
      state.seen.add(key);
      state.queue.push(item);
      added += 1;
    }
    return added;
  }

  function scrollCandidates() {
    const viewportArea = window.innerWidth * window.innerHeight;
    return [...document.querySelectorAll("div, main, section")]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const overflow = el.scrollHeight - el.clientHeight;
        const area = rect.width * rect.height;
        const text = clean(el.innerText || "", 2000);
        const customerHints = (text.match(/message|marketplace|reply|active|sent|pickup|customer|messenger/gi) || []).length;
        return { el, overflow, area, customerHints, rect };
      })
      .filter((item) => item.overflow > 80 && item.area > viewportArea * 0.08)
      .sort((a, b) => (b.customerHints * 2000 + b.overflow + b.area / 1000) - (a.customerHints * 2000 + a.overflow + a.area / 1000));
  }

  function scrollPage() {
    const candidates = scrollCandidates();
    const target = candidates[0]?.el;
    if (target) {
      target.scrollTop += Math.max(600, Math.floor(target.clientHeight * 0.85));
      target.dispatchEvent(new Event("scroll", { bubbles: true }));
      return "container";
    }
    window.scrollBy(0, Math.max(700, Math.floor(window.innerHeight * 0.85)));
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 900, bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    return "window";
  }

  function progress() {
    const elapsed = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
    const importElapsed = state.importStartedAt ? Math.max(1, Math.round((Date.now() - state.importStartedAt) / 1000)) : 0;
    const remaining = Math.max(0, state.queue.length - state.imported - state.failed);
    const rate = state.imported > 0 ? state.imported / importElapsed : 0;
    const etaSeconds = rate > 0 ? Math.round(remaining / rate) : null;
    return {
      ok: true,
      scanning: state.scanning,
      importing: state.importing,
      paused: state.paused,
      queued: state.queue.length,
      imported: state.imported,
      failed: state.failed,
      duplicateInPage: state.duplicateInPage,
      remaining,
      scanRounds: state.scanRounds,
      stagnantRounds: state.stagnantRounds,
      elapsed,
      etaSeconds,
      message: state.message
    };
  }

  async function saveQueue() {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        queue: state.queue,
        imported: state.imported,
        failed: state.failed,
        duplicateInPage: state.duplicateInPage,
        savedAt: new Date().toISOString()
      }
    });
  }

  async function loadQueue() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const saved = data[STORAGE_KEY] || {};
    state.queue = Array.isArray(saved.queue) ? saved.queue : [];
    state.seen = new Set(state.queue.map(customerKey));
    state.imported = Number(saved.imported || 0);
    state.failed = Number(saved.failed || 0);
    state.duplicateInPage = Number(saved.duplicateInPage || 0);
    state.message = state.queue.length ? "Queue loaded" : "Ready";
    return progress();
  }

  async function submit(customers) {
    if (!config.crmUrl || !config.captureToken || config.captureToken.includes("PUT_")) {
      throw new Error("Extension config.js is missing CRM URL or capture token.");
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
      throw new Error(data.error || "CRM save failed.");
    }
    return data;
  }

  async function scanAll(options = {}) {
    if (state.scanning) return progress();
    const maxCustomers = Math.max(1, Math.min(Number(options.maxCustomers || 3000), 20000));
    const delayMs = Math.max(300, Math.min(Number(options.scanDelayMs || 1400), 10000));
    const stagnantLimit = Math.max(3, Math.min(Number(options.stagnantLimit || 12), 80));

    state.scanning = true;
    state.stopRequested = false;
    state.startedAt = Date.now();
    state.scanRounds = 0;
    state.stagnantRounds = 0;
    state.message = "Scanning visible customers...";

    while (!state.stopRequested && state.queue.length < maxCustomers && state.stagnantRounds < stagnantLimit) {
      const before = state.queue.length;
      const found = visibleListCustomers();
      const added = addToQueue(found);
      state.scanRounds += 1;
      state.stagnantRounds = added ? 0 : state.stagnantRounds + 1;
      state.message = `Round ${state.scanRounds}: found ${found.length}, added ${added}, total ${state.queue.length}.`;
      await saveQueue();
      if (state.queue.length >= maxCustomers) break;
      scrollPage();
      if (state.queue.length === before && !added) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      }
      await sleep(delayMs);
    }

    state.scanning = false;
    state.message = state.stopRequested ? "Scan stopped." : `Scan finished. ${state.queue.length} customers in queue.`;
    await saveQueue();
    return progress();
  }

  async function importQueue(options = {}) {
    if (state.importing) return progress();
    if (!state.queue.length) await loadQueue();
    const batchSize = Math.max(1, Math.min(Number(options.batchSize || 25), 50));
    const delayMs = Math.max(500, Math.min(Number(options.importDelayMs || 3000), 60000));

    state.importing = true;
    state.paused = false;
    state.stopRequested = false;
    state.importStartedAt = Date.now();
    state.message = "Importing queue...";

    while (!state.stopRequested && state.imported + state.failed < state.queue.length) {
      while (state.paused && !state.stopRequested) {
        state.message = "Import paused.";
        await sleep(600);
      }
      if (state.stopRequested) break;
      const start = state.imported + state.failed;
      const batch = state.queue.slice(start, start + batchSize);
      if (!batch.length) break;
      try {
        const data = await submit(batch);
        state.imported += Number(data.saved || batch.length);
        state.message = `Imported ${state.imported}/${state.queue.length}.`;
      } catch (error) {
        state.failed += batch.length;
        state.message = `Batch failed: ${error.message || error}`;
      }
      await saveQueue();
      if (state.imported + state.failed < state.queue.length) await sleep(delayMs);
    }

    state.importing = false;
    state.message = state.stopRequested ? "Import stopped." : "Import finished.";
    await saveQueue();
    return progress();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message.action === "status") {
        await loadQueue();
        sendResponse(progress());
        return;
      }
      if (message.action === "testConfig") {
        sendResponse({ ok: true, message: config.crmUrl ? "Config loaded" : "Config missing" });
        return;
      }
      if (message.action === "captureCurrent") {
        const customer = currentCustomer();
        addToQueue([customer]);
        await saveQueue();
        const data = await submit([customer]);
        state.imported += Number(data.saved || 1);
        await saveQueue();
        sendResponse({ ok: true, result: data.results?.[0] || customer, ...progress() });
        return;
      }
      if (message.action === "scanVisible") {
        const customers = visibleListCustomers();
        const added = addToQueue(customers);
        await saveQueue();
        sendResponse({ ok: true, found: customers.length, added, ...progress() });
        return;
      }
      if (message.action === "scanAll") {
        scanAll(message.options || {});
        sendResponse(progress());
        return;
      }
      if (message.action === "importQueue") {
        importQueue(message.options || {});
        sendResponse(progress());
        return;
      }
      if (message.action === "pauseImport") {
        state.paused = true;
        sendResponse(progress());
        return;
      }
      if (message.action === "resumeImport") {
        state.paused = false;
        sendResponse(progress());
        return;
      }
      if (message.action === "stop") {
        state.stopRequested = true;
        state.scanning = false;
        state.paused = false;
        sendResponse(progress());
        return;
      }
      if (message.action === "clearQueue") {
        state.queue = [];
        state.seen = new Set();
        state.imported = 0;
        state.failed = 0;
        state.duplicateInPage = 0;
        state.message = "Queue cleared.";
        await saveQueue();
        sendResponse(progress());
      }
    })().catch((error) => sendResponse({ ok: false, error: error.message || String(error), ...progress() }));
    return true;
  });

  loadQueue();
})();
