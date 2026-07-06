import fs from "node:fs";
import path from "node:path";

const API_BASE = process.env.API_BASE_URL ?? process.argv[2] ?? "https://coolfix-omni-api.onrender.com";
const ENV_PATH = path.join(process.cwd(), ".env");
const allowPartial = process.argv.includes("--partial");
const API_PUBLIC_URL = process.env.API_PUBLIC_URL?.replace(/\/$/, "") || API_BASE.replace(/\/$/, "");

function readEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (value === "") continue;
    env[key] = value;
  }
  return env;
}

function present(value) {
  return Boolean(value && value.trim().length > 0 && value !== "__PLACEHOLDER__");
}

function isSelfLoopWebhook(url, targetPath) {
  if (!url) return false;
  const normalizedPath = normalizeCallbackPath(url);
  const expected = normalizeCallbackPath(targetPath);
  if (normalizedPath && expected && (normalizedPath === expected || normalizedPath === `/api${expected}`)) return true;

  try {
    const parsedUrl = new URL(url);
    const parsedApi = new URL(API_PUBLIC_URL);
    const normalized = parsedUrl.pathname.replace(/\/+$/, "").toLowerCase();
    return parsedUrl.host === parsedApi.host && (normalized === expected || normalized === `/api${expected}`);
  } catch {
    return false;
  }
}

function normalizeCallbackPath(value) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith("/")) return null;
  return normalized.replace(/\/+$/, "");
}

function buildFromEnv() {
  const env = { ...readEnv(ENV_PATH), ...process.env };

  const accounts = [];

  const twilioSid = (env.TWILIO_ACCOUNT_SID || "").trim();
  const twilioAuth = (env.TWILIO_AUTH_TOKEN || "").trim();
  if (present(twilioSid) && present(twilioAuth)) {
    const twilioDefaultFrom = (env.TWILIO_DEFAULT_FROM || env.TWILIO_PHONE_NUMBER || env.TWILIO_VOICE_FROM || env.TWILIO_FROM_NUMBER || "").trim();
    const twilioMessagingServiceSid = (env.TWILIO_MESSAGING_SERVICE_SID || "").trim();

    accounts.push({
      name: "AUTO_TWILIO_SMS",
      channel: "sms",
      providerAccountId: twilioSid,
      externalPageId: twilioDefaultFrom || null,
      fromAddress: twilioDefaultFrom,
      encryptedToken: "",
      encryptedSecret: twilioAuth,
      settings: {
        messagingServiceSid: twilioMessagingServiceSid || "",
        fromAddress: twilioDefaultFrom || "",
        accountId: twilioSid,
      },
    });

    accounts.push({
      name: "AUTO_TWILIO_VOICE",
      channel: "phone",
      providerAccountId: twilioSid,
      externalPageId: twilioDefaultFrom || null,
      fromAddress: (env.TWILIO_VOICE_FROM || twilioDefaultFrom || "").trim(),
      encryptedToken: "",
      encryptedSecret: twilioAuth,
      settings: {
        accountSid: twilioSid,
        voiceCallbackUrl: env.TWILIO_VOICE_CALLBACK_URL || "",
        voiceStatusCallbackUrl: env.TWILIO_VOICE_STATUS_CALLBACK_URL || "",
      },
    });
  }

  const whatsappAccessToken = (env.WHATSAPP_ACCESS_TOKEN || env.META_ACCESS_TOKEN || "").trim();
  const whatsappPhoneId = (env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  if (present(whatsappAccessToken) && present(whatsappPhoneId)) {
    accounts.push({
      name: "AUTO_WHATSAPP",
      channel: "whatsapp",
      providerAccountId: whatsappPhoneId,
      externalPageId: whatsappPhoneId,
      encryptedToken: whatsappAccessToken,
      encryptedSecret: "",
      settings: {
        phoneNumberId: whatsappPhoneId,
      },
    });
  }

  const messengerToken = (env.MESSENGER_PAGE_ACCESS_TOKEN || env.PAGE_ACCESS_TOKEN || env.META_PAGE_ACCESS_TOKEN || "").trim();
  if (present(messengerToken)) {
    const messengerPageId = (env.MESSENGER_PAGE_ID || "").trim();
    accounts.push({
      name: "AUTO_MESSENGER",
      channel: "messenger",
      providerAccountId: messengerPageId || null,
      externalPageId: messengerPageId || null,
      encryptedToken: messengerToken,
      encryptedSecret: "",
      settings: {
        pageAccessToken: messengerToken,
        pageId: messengerPageId || "",
      },
    });
  }

  const instagramAccessToken = (env.INSTAGRAM_ACCESS_TOKEN || env.META_ACCESS_TOKEN || "").trim();
  const instagramAccountId = (env.INSTAGRAM_BUSINESS_ACCOUNT_ID || env.INSTAGRAM_ACCOUNT_ID || "").trim();
  if (present(instagramAccessToken) && present(instagramAccountId)) {
    accounts.push({
      name: "AUTO_INSTAGRAM",
      channel: "instagram",
      providerAccountId: instagramAccountId,
      externalPageId: instagramAccountId,
      encryptedToken: instagramAccessToken,
      encryptedSecret: "",
      settings: {
        businessAccountId: instagramAccountId,
      },
    });
  }

  const websiteWebhook = (env.WEBSITE_CHAT_WEBHOOK_URL || "").trim();
  if (present(websiteWebhook) && !isSelfLoopWebhook(websiteWebhook, "/api/webhooks/website-chat")) {
    accounts.push({
      name: "AUTO_WEBSITE_CHAT",
      channel: "website_chat",
      providerAccountId: "",
      externalPageId: "",
      fromAddress: websiteWebhook,
      encryptedToken: "",
      encryptedSecret: "",
      settings: {
        webhookUrl: websiteWebhook,
        webhookToken: env.WEBSITE_CHAT_WEBHOOK_TOKEN || "",
      },
    });
  }

  const resendApiKey = (env.RESEND_API_KEY || "").trim();
  const resendFrom = (env.RESEND_FROM || env.EMAIL_FROM_ADDRESS || "").trim();
  const emailWebhook = (env.EMAIL_WEBHOOK_URL || "").trim();
  if (present(resendApiKey) && present(resendFrom)) {
    accounts.push({
      name: "AUTO_EMAIL_RESEND",
      channel: "email",
      providerAccountId: "",
      externalPageId: "",
      fromAddress: resendFrom,
      encryptedToken: resendApiKey,
      encryptedSecret: "",
      settings: {
        resendApiKey,
        resendFrom,
      },
    });
  } else if (present(emailWebhook)) {
    if (!isSelfLoopWebhook(emailWebhook, "/api/webhooks/email")) {
      accounts.push({
        name: "AUTO_EMAIL_WEBHOOK",
        channel: "email",
        providerAccountId: "",
        externalPageId: "",
        fromAddress: "",
        encryptedToken: "",
        encryptedSecret: "",
        settings: {
          webhookUrl: emailWebhook,
          webhookToken: env.EMAIL_WEBHOOK_TOKEN || "",
        },
      });
    }
  }

  return accounts.filter((account) => {
    if (!account.name) return false;
    if (account.channel === "sms" || account.channel === "phone") {
      return present(account.providerAccountId) && present(account.encryptedSecret);
    }
    return true;
  });
}

async function apiRequest(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const response = await fetch(`${API_BASE.replace(/\/$/, "")}${path}`, {
    ...options,
    headers,
  });
  const bodyText = await response.text();
  let body = bodyText;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // keep plain text
  }

  if (!response.ok) {
    throw new Error(`API ${options.method ?? "GET"} ${path} -> ${response.status} ${bodyText}`);
  }
  return body;
}

async function run() {
  const plan = buildFromEnv();
  if (!plan.length) {
    const msg = "No complete channel credentials found in .env to sync.";
    console.log(msg);
    process.exit(allowPartial ? 0 : 1);
  }

  const current = await apiRequest("/api/channel-accounts");
  console.log(`Current channel-accounts: ${Array.isArray(current) ? current.length : 0}`);

  for (const account of plan) {
    const match = Array.isArray(current)
      ? current.find((item) => item.channel === account.channel && item.name === account.name)
      : null;

    const payload = {
      name: account.name,
      channel: account.channel,
      providerAccountId: account.providerAccountId || null,
      externalPageId: account.externalPageId || null,
      fromAddress: account.fromAddress || null,
      encryptedToken: account.encryptedToken || null,
      encryptedSecret: account.encryptedSecret || null,
      settings: account.settings || {},
      isActive: true,
    };

    if (match?.id) {
      const updated = await apiRequest(`/api/channel-accounts/${match.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      console.log(`Updated ${account.channel} account: ${match.id} (${account.name})`);
      continue;
    }

    const created = await apiRequest("/api/channel-accounts", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    console.log(`Created ${account.channel} account: ${created?.id || account.name}`);
  }

  console.log("Channel-account sync complete.");
}

run().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
