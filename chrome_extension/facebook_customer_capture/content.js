(function () {
  if (window.__COOLFIX_CRM_CUSTOMER_CAPTURE_LOADED__) return;
  window.__COOLFIX_CRM_CUSTOMER_CAPTURE_LOADED__ = true;

  const config = window.COOLFIX_CRM_CAPTURE_CONFIG || {};

  const state = {
    running: false,
    uploading: false,
    seen: new Set(),
    queue: [],
    found: 0,
    uploaded: 0,
    failed: 0,
    skipped: 0,
    message: "Ready",
    observer: null,
    debounceTimer: null
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

  function comparableUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/$/, "")}`;
    } catch {
      return String(url || "").split("?")[0].split("#")[0].replace(/\/$/, "");
    }
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

  function isMarketplaceInboxView() {
    const url = String(location.href || "").toLowerCase();
    if (url.includes("marketplace")) return true;

    const title = `${document.title || ""} ${pageTitle()}`.toLowerCase();
    if (title.includes("marketplace")) return true;

    const headings = [...document.querySelectorAll("h1,h2,[role='heading'],[aria-selected='true']")]
      .filter(visible)
      .map((el) => clean(el.innerText || el.textContent || el.getAttribute("aria-label"), 120).toLowerCase());
    return headings.some((text) => text.includes("marketplace"));
  }

  function isMessengerThreadLink(href) {
    const value = String(href || "").toLowerCase();
    return value.includes("messenger.com/t/")
      || value.includes("facebook.com/messages/t/")
      || value.includes("/messages/t/")
      || value.includes("/messages/e2ee/t/");
  }

  function marketplaceThreadSignal(anchor) {
    const row = anchor.closest("[role='row'],li,div") || anchor;
    const text = clean(`${row.innerText || row.textContent || ""} ${anchor.getAttribute("aria-label") || ""}`, 1800).toLowerCase();
    if (!text) return false;
    return [
      "marketplace",
      "facebook marketplace",
      "listing",
      "seller",
      "buyer",
      "offer",
      "is this available",
      "still available",
      "pickup",
      "pick up",
      "item"
    ].some((signal) => text.includes(signal));
  }

  function likelyCustomerLink(href) {
    const value = String(href || "").toLowerCase();
    if (!value.includes("facebook.com") && !value.includes("messenger.com")) return false;
    if (value.includes("/groups/") || value.includes("/settings") || value.includes("/help")) return false;
    if (value.includes("/notifications") || value.includes("/watch") || value.includes("/reel/")) return false;

    const mode = currentMode();
    if (mode === "messenger") return isMessengerThreadLink(value);
    if (mode === "marketplace") return isMessengerThreadLink(value) || value.includes("/messages/");
    return isMessengerThreadLink(value) || value.includes("/messages/");
  }

  function bestAvatar(root) {
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

  function itemFromAnchor(anchor) {
    const href = absoluteUrl(anchor.getAttribute("href") || anchor.href || "");
    if (!likelyCustomerLink(href)) return null;

    const mode = currentMode();
    const marketplaceView = isMarketplaceInboxView();
    if (mode === "messenger" && !marketplaceView && !marketplaceThreadSignal(anchor)) return null;

    const name = nameFromAnchor(anchor);
    if (!name || name.length < 2) return null;

    return {
      source: "marketplace",
      display_name: clean(name, 160),
      profile_pic_url: bestAvatar(anchor),
      profile_url: href,
      conversation_url: href,
      thread_url: href,
      marketplace_item_url: href,
      page_url: location.href,
      page_title: pageTitle(),
      latest_message: clean(anchor.innerText || anchor.textContent, 1000),
      captured_at: new Date().toISOString()
    };
  }

  function itemKey(item) {
    return `${item.source}|${comparableUrl(item.conversation_url || item.profile_url || item.thread_url)}`;
  }

  function scanVisible() {
    const anchors = [...document.querySelectorAll("a[href]")].filter(visible);
    let added = 0;
    for (const anchor of anchors) {
      const item = itemFromAnchor(anchor);
      if (!item) continue;
      const key = itemKey(item);
      if (state.seen.has(key)) {
        state.skipped += 1;
        continue;
      }
      state.seen.add(key);
      state.queue.push(item);
      state.found += 1;
      added += 1;
    }
    state.message = added ? `Added ${added} customers from visible list.` : "Watching list. Scroll to load more customers.";
    if (state.queue.length >= 25) uploadQueue(false);
    return added;
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

  async function uploadQueue(force) {
    if (state.uploading) return progress();
    if (!state.queue.length) return progress();
    if (!force && state.queue.length < 25) return progress();

    const batch = state.queue.splice(0, force ? state.queue.length : 25);
    state.uploading = true;
    state.message = `Uploading ${batch.length} customers to CRM...`;
    try {
      const data = await submit(batch);
      state.uploaded += Number(data.saved || batch.length);
      state.message = `Uploaded ${state.uploaded} customers. Keep scrolling.`;
    } catch (error) {
      state.failed += batch.length;
      state.message = `Upload failed: ${error.message || error}`;
      state.queue.unshift(...batch);
    } finally {
      state.uploading = false;
    }
    return progress();
  }

  function scheduleScan() {
    if (!state.running) return;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(scanVisible, 250);
  }

  function startScrollCapture() {
    if (state.running) return progress();
    state.running = true;
    state.message = "Started. Scroll the Marketplace chat list.";
    window.addEventListener("scroll", scheduleScan, true);
    state.observer = new MutationObserver(scheduleScan);
    state.observer.observe(document.body, { childList: true, subtree: true });
    scanVisible();
    return progress();
  }

  async function stopScrollCapture() {
    state.running = false;
    window.removeEventListener("scroll", scheduleScan, true);
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    clearTimeout(state.debounceTimer);
    await uploadQueue(true);
    state.message = "Stopped. Remaining customers uploaded.";
    return progress();
  }

  function progress() {
    return {
      ok: true,
      running: state.running,
      uploading: state.uploading,
      found: state.found,
      queued: state.queue.length,
      uploaded: state.uploaded,
      failed: state.failed,
      skipped: state.skipped,
      message: state.message
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message.action === "status") {
        sendResponse(progress());
        return;
      }
      if (message.action === "startSequentialCapture" || message.action === "startScrollCapture") {
        sendResponse(startScrollCapture());
        return;
      }
      if (message.action === "stopSequentialCapture" || message.action === "stopScrollCapture") {
        sendResponse(await stopScrollCapture());
        return;
      }
      if (message.action === "captureCurrentOnly" || message.action === "scanVisible") {
        const added = scanVisible();
        const result = await uploadQueue(true);
        sendResponse({ ...result, added });
      }
    })().catch((error) => sendResponse({ ok: false, error: error.message || String(error), ...progress() }));
    return true;
  });
})();
