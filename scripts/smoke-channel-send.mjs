const TARGET_CHANNELS = [
  "whatsapp",
  "messenger",
  "instagram",
  "sms",
  "website_chat",
  "email",
  "phone",
];

function hasInboundMessage(conversation) {
  return Array.isArray(conversation?.messages) && conversation.messages.some((message) => message?.direction === "inbound");
}

function hasRecentInbound(conversation, hours = 24) {
  if (!Array.isArray(conversation?.messages)) return false;
  const now = Date.now();
  const threshold = now - hours * 60 * 60 * 1000;
  return conversation.messages.some((message) => {
    if (message?.direction !== "inbound" || !message?.sentAt) return false;
    const sentAt = Date.parse(message.sentAt);
    return Number.isFinite(sentAt) && sentAt >= threshold;
  });
}

function isLikelyTestConversation(conversation, channel) {
  const threadId = String(conversation?.externalThreadId ?? "").trim();
  const customerId = String(conversation?.customer?.id ?? "").trim();
  const customerName = String(conversation?.customer?.displayName ?? "").trim().toLowerCase();

  if (threadId.startsWith("legacy:") || threadId.startsWith("test") || threadId.startsWith("m_sender_") || threadId.startsWith("ig_sender_")) {
    return true;
  }

  if (!hasInboundMessage(conversation)) {
    return true;
  }

  if (channel === "messenger" || channel === "instagram") {
    if (!/^\d{8,}$/.test(threadId)) return true;
  }

  if (channel === "whatsapp" || channel === "sms" || channel === "phone") {
    if (!/^\+?\d{7,20}$/.test(threadId)) return true;
  }

  if (customerName === "new customer" || customerName === "test user") {
    return true;
  }
  if (channel === "website_chat" && threadId.length < 2) return true;
  if (channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(conversation?.customer?.primaryEmail ?? "")) return true;

  return false;
}

function isWindowSafeForMetaConversation(channel, conversation) {
  if (channel !== "messenger" && channel !== "instagram") return true;
  return hasRecentInbound(conversation, 24);
}

const cliArgs = process.argv.slice(2);
const API_BASE = cliArgs.find((arg) => !arg.startsWith("--"))
  ?? process.env.API_BASE_URL
  ?? process.env.API_PUBLIC_URL
  ?? "https://coolfix-omni-api.onrender.com";
const runSend = cliArgs.includes("--send");
const tag = `[channel-smoke-${new Date().toISOString()}]`;

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  const parsed = text ? (() => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  })() : null;

  return {
    ok: response.ok,
    status: response.status,
    body: parsed,
  };
}

async function fetchConversation(base, channel) {
  const listUrl = `${base.replace(/\/$/, "")}/api/conversations?channel=${encodeURIComponent(channel)}&limit=20`;
  const result = await fetchJson(listUrl);
  if (!result.ok || !Array.isArray(result.body)) {
    return null;
  }
  const list = result.body;
  const usable = list.find((conversation) => !isLikelyTestConversation(conversation, channel) && isWindowSafeForMetaConversation(channel, conversation));
  if (usable) return usable;

  if (channel === "messenger" || channel === "instagram") return null;

  return list.find((conversation) => !isLikelyTestConversation(conversation, channel)) ?? list[0] ?? null;
}

function maybeExplainSkip(channel) {
  if (channel === "messenger" || channel === "instagram") {
    return "no_recent_inbound_for_24h_window";
  }
  return "no_valid_live_conversation";
}

async function sendSmoke(base, conversationId, channel) {
  const payload = {
    conversationId,
    text: `${tag} test for ${channel}`,
  };
  return fetchJson(`${base.replace(/\/$/, "")}/api/messages/send`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function run() {
  console.log(`Channel smoke run against ${API_BASE}`);
  console.log(`mode=${runSend ? "send" : "dry-run"}`);

  const results = [];

  for (const channel of TARGET_CHANNELS) {
    const conversation = await fetchConversation(API_BASE, channel);
    if (!conversation) {
      results.push({ channel, status: maybeExplainSkip(channel) });
      continue;
    }

    if (!runSend) {
      results.push({
        channel,
        status: "READY",
        conversationId: conversation.id,
        customer: conversation.customer?.displayName ?? conversation.customerId,
      });
      continue;
    }

    const sent = await sendSmoke(API_BASE, conversation.id, channel);
    const deliveryStatus = sent.body?.delivery ?? sent.body?.message?.status ?? "unknown";
    const failedReason = sent.body?.failedReason ?? sent.body?.message?.failedReason;
    results.push({
      channel,
      status: sent.ok ? "SEND_REQUESTED" : `SEND_REQUEST_FAILED_${sent.status}`,
      conversationId: conversation.id,
      deliveryStatus,
      failedReason: failedReason ?? null,
      statusCode: sent.status,
      response: sent.body,
    });
  }

  for (const result of results) {
    if (!runSend || result.status === "READY" || result.status === "NO_CONVERSATION") {
      console.log(`${result.channel}: ${result.status}${result.conversationId ? ` conv=${result.conversationId}` : ""}${result.customer ? ` customer=${result.customer}` : ""}`);
      continue;
    }

    console.log(`${result.channel}: ${result.status}, delivery=${result.deliveryStatus}, reason=${result.failedReason ?? "none"}`);
  }
}

run().catch((error) => {
  console.error("smoke-channel-send failed", error);
  process.exit(1);
});
