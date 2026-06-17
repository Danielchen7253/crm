(function () {
  const config = window.COOLFIX_CRM_CAPTURE_CONFIG || {};

  const state = {
    running: false,
    timer: null,
    seen: new Set(),
    batch: [],
    scanned: 0,
    uploaded: 0,
    failed: 0,
    rounds: 0,
    message: "Ready"
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

  function bestAvatar(root) {
    const candidates = [...root.querySelectorAll("img")]
      .filter(visible)
      .map((img) => {
        const rect = img.getBoundingClientRect();
        const src = img.currentSrc || img.src || "";
        const score = Math.min(rect.width, rect.height) + (src.includes("fbcdn") || src.includes("fbsbx") ? 80 : 0);
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
    if (value.includes("/notifications") || value.includes("/watch") || value.includes("/reel/")) return false;
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

  function extractFromAnchor(anchor) {
    const href = absoluteUrl(anchor.getAttribute("href") || anchor.href || "");
    if (!likelyCustomerLink(href)) return null;

    const name = nameFromAnchor(anchor);
    if (!name || name.length < 2) return null;

    const source = sourceFromUrl(href);
    const text = clean(anchor.innerText || anchor.textContent, 1000);
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

  function scanVisibleCustomers() {
    const anchors = [...document.querySelectorAll("a[href]")].filter(visible);
    const found = anchors.map(extractFromAnchor).filter(Boolean);
    let added = 0;

    for (const item of found) {
      const key = customerKey(item);
      if (!key || state.seen.has(key)) continue;
      state.seen.add(key);
      state.batch.push(item);
      state.scanned += 1;
      added += 1;
    }

    state.message = added ? `Found ${added} new customers` : "No new visible customers";
    return added;
  }

  function scrollTarget() {
    const viewportArea = window.innerWidth * window.innerHeight;
    const candidates = [...document.querySelectorAll("div, main, section")]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const overflow = el.scrollHeight - el.clientHeight;
        const area = rect.width * rect.height;
        const text = clean(el.innerText || "", 1600);
        const hints = (text.match(/marketplace|messenger|message|reply|active|sent|buyer|customer/gi) || []).length;
        return { el, overflow, area, hints };
      })
      .filter((item) => item.overflow > 80 && item.area > viewportArea * 0.06)
      .sort((a, b) => (b.hints * 3000 + b.overflow + b.area / 1000) - (a.hints * 3000 + a.overflow + a.area / 1000));
    return candidates[0]?.el || null;
  }

  function slowScroll() {
    const target = scrollTarget();
    if (target) {
      target.scrollTop += Math.max(280, Math.floor(target.clientHeight * 0.55));
      target.dispatchEvent(new Event("scroll", { bubbles: true }));
      return;
    }
    window.scrollBy(0, Math.max(320, Math.floor(window.innerHeight * 0.55)));
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

  async function uploadBatch(force = false) {
    if (!state.batch.length) return;
    if (!force && state.batch.length < 20) return;

    const customers = state.batch.splice(0, 20);
    state.message = `Uploading ${customers.length} customers`;

    try {
      const data = await submit(customers);
      state.uploaded += Number(data.saved || customers.length);
      state.message = `Uploaded ${state.uploaded} customers`;
    } catch (error) {
      state.failed += customers.length;
      state.message = `Upload failed: ${error.message || error}`;
    }
  }

  async function runLoop() {
    while (state.running) {
      state.rounds += 1;
      scanVisibleCustomers();
      await uploadBatch(false);
      slowScroll();
      await sleep(2200);
    }
  }

  async function startAutoCapture() {
    if (state.running) return progress();
    state.running = true;
    state.message = "Auto capture started";
    runLoop();
    return progress();
  }

  async function stopAutoCapture() {
    state.running = false;
    state.message = "Stopping and uploading remaining customers";
    await uploadBatch(true);
    state.message = "Stopped";
    return progress();
  }

  function progress() {
    return {
      ok: true,
      running: state.running,
      scanned: state.scanned,
      uploaded: state.uploaded,
      queued: state.batch.length,
      failed: state.failed,
      rounds: state.rounds,
      message: state.message
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message.action === "status") {
        sendResponse(progress());
        return;
      }
      if (message.action === "testConfig") {
        sendResponse({ ok: true, message: config.crmUrl ? "配置已加载" : "缺少配置" });
        return;
      }
      if (message.action === "startAutoCapture") {
        sendResponse(await startAutoCapture());
        return;
      }
      if (message.action === "stopAutoCapture") {
        sendResponse(await stopAutoCapture());
        return;
      }
      if (message.action === "scanVisible") {
        const added = scanVisibleCustomers();
        await uploadBatch(true);
        sendResponse({ ...progress(), added });
      }
    })().catch((error) => sendResponse({ ok: false, error: error.message || String(error), ...progress() }));
    return true;
  });
})();
