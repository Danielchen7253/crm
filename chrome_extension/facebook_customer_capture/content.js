(function () {
  const config = window.COOLFIX_CRM_CAPTURE_CONFIG || {};

  function clean(text, limit = 500) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
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

  function bestHeading() {
    const headings = [...document.querySelectorAll("h1,h2,[role='heading']")]
      .filter(visible)
      .map((el) => clean(el.innerText || el.textContent, 180))
      .filter((text) => text && !/facebook|messenger|marketplace/i.test(text));
    return headings[0] || "";
  }

  function bestAvatar() {
    const candidates = [...document.images]
      .filter(visible)
      .map((img) => {
        const rect = img.getBoundingClientRect();
        const src = img.currentSrc || img.src || "";
        const score = Math.min(rect.width, rect.height) + (src.includes("fbcdn") || src.includes("fbsbx") ? 60 : 0);
        return { src, score, width: rect.width, height: rect.height };
      })
      .filter((item) => item.src && item.width >= 32 && item.height >= 32 && !item.src.includes("emoji"))
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.src || "";
  }

  function bestProfileUrl() {
    const anchors = [...document.querySelectorAll("a[href]")]
      .filter(visible)
      .map((a) => a.href)
      .filter((href) => {
        const value = href.toLowerCase();
        return value.includes("facebook.com/") &&
          !value.includes("/groups/") &&
          !value.includes("/marketplace/") &&
          !value.includes("/messages/") &&
          !value.includes("/notifications") &&
          !value.includes("/settings") &&
          !value.includes("/help");
      });
    return anchors[0] || "";
  }

  function latestVisibleMessage() {
    const texts = [...document.querySelectorAll('[data-ad-preview="message"], [dir="auto"], div[role="row"], span')]
      .filter(visible)
      .map((el) => clean(el.innerText || el.textContent, 500))
      .filter((text) => text.length >= 2 && text.length <= 500)
      .filter((text) => !/^(like|reply|send|search|home|notifications|messenger)$/i.test(text));
    return texts.slice(-8).join(" | ").slice(0, 1000);
  }

  function currentCustomer() {
    const title = pageTitle();
    const name = bestHeading() || title || "Facebook Customer";
    const source = sourceFromUrl(location.href);
    return {
      source,
      display_name: clean(name, 160),
      profile_pic_url: bestAvatar(),
      profile_url: bestProfileUrl(),
      conversation_url: location.href,
      thread_url: location.href,
      marketplace_item_url: source === "marketplace" ? location.href : "",
      page_url: location.href,
      page_title: title,
      latest_message: latestVisibleMessage(),
      captured_at: new Date().toISOString()
    };
  }

  function visibleListCustomers() {
    const source = sourceFromUrl(location.href);
    const rows = [...document.querySelectorAll("a[href]")]
      .filter(visible)
      .map((a) => {
        const text = clean(a.innerText || a.textContent, 180);
        const href = a.href;
        const img = a.querySelector("img");
        return {
          source,
          display_name: text.split("\n")[0] || text,
          profile_pic_url: img ? (img.currentSrc || img.src || "") : "",
          profile_url: href,
          conversation_url: href,
          thread_url: href,
          page_url: location.href,
          page_title: pageTitle(),
          latest_message: text,
          captured_at: new Date().toISOString()
        };
      })
      .filter((item) => item.display_name && item.display_name.length >= 2)
      .filter((item) => {
        const href = String(item.profile_url || "").toLowerCase();
        return href.includes("facebook.com") || href.includes("messenger.com");
      });

    const seen = new Set();
    return rows.filter((item) => {
      const key = `${item.profile_url}|${item.display_name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 25);
  }

  async function submit(customers) {
    if (!config.crmUrl || !config.captureToken || config.captureToken.includes("PUT_")) {
      throw new Error("插件 config.js 没配置 CRM 地址或采集 token。");
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

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message.action === "testConfig") {
        sendResponse({ ok: true, result: { display_name: config.crmUrl ? "配置已加载" : "未配置" } });
        return;
      }
      if (message.action === "captureCurrent") {
        const customer = currentCustomer();
        const data = await submit([customer]);
        sendResponse({ ok: true, result: data.results?.[0] || customer });
        return;
      }
      if (message.action === "scanVisible") {
        const customers = visibleListCustomers();
        if (!customers.length) {
          sendResponse({ ok: false, error: "当前页面没有识别到可保存的客户链接。" });
          return;
        }
        const data = await submit(customers);
        sendResponse({ ok: true, saved: data.saved || 0, result: data });
      }
    })().catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });
})();
