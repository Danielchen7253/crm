const CRM_BASE = "https://crm-8t7y.onrender.com";

async function crmFetch(path, options = {}) {
  const res = await fetch(`${CRM_BASE}${path}`, {
    credentials: "include",
    ...options,
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("CRM is locked. Open CRM and log in first.");
    throw new Error(`CRM request failed: ${res.status}`);
  }
  return res.json();
}

async function getState(params = {}) {
  const search = new URLSearchParams();
  if (params.postId) search.set("post", params.postId);
  if (params.groupId) search.set("group", params.groupId);
  const suffix = search.toString() ? `?${search}` : "";
  return crmFetch(`/api/promotion/extension-state${suffix}`);
}

async function markPosted(groupId, postId) {
  return crmFetch(`/api/promotion/groups/${groupId}/mark`, {
    method: "POST",
    body: JSON.stringify({ post_id: postId || "" })
  });
}

async function openGroupInCurrentTab(group) {
  if (!group || !group.url) throw new Error("No group URL found.");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab found.");
  await chrome.tabs.update(tab.id, { url: group.url });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "getState") {
      sendResponse(await getState(message));
      return;
    }
    if (message.type === "openCurrentGroup") {
      const state = await getState(message);
      await openGroupInCurrentTab(state.current_group);
      sendResponse(state);
      return;
    }
    if (message.type === "markPosted") {
      const state = await markPosted(message.groupId, message.postId);
      if (state.current_group) await openGroupInCurrentTab(state.current_group);
      sendResponse(state);
      return;
    }
    sendResponse({ ok: false, error: "Unknown message type." });
  })().catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
