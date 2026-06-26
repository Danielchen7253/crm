import fs from "node:fs";
import path from "node:path";

function readEnv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    env[key] = value;
  }
  return env;
}

function present(value) {
  return Boolean(value && value.trim().length > 0);
}

function mask(value) {
  if (!value) return "missing";
  const v = value.trim();
  if (v.length <= 6) return "***";
  return `${"*".repeat(Math.max(0, v.length - 4))}${v.slice(-4)}`;
}

function check(label, ok, details) {
  console.log(`${label.padEnd(24)} ${ok ? "OK" : "MISSING"}  ${details}`);
}

const envPath = path.join(process.cwd(), ".env");
if (!fs.existsSync(envPath)) {
  console.error("Missing .env; run: cp .env.example .env");
  process.exit(1);
}

const env = { ...process.env, ...readEnv(envPath) };

console.log("CRM channel config audit");
console.log("=======================");

check(
  "WHATSAPP",
  present(env.WHATSAPP_PHONE_NUMBER_ID) && (present(env.WHATSAPP_ACCESS_TOKEN) || present(env.META_ACCESS_TOKEN)),
  `phone=${present(env.WHATSAPP_PHONE_NUMBER_ID) ? mask(env.WHATSAPP_PHONE_NUMBER_ID) : "missing"}, token=${present(env.WHATSAPP_ACCESS_TOKEN) || present(env.META_ACCESS_TOKEN) ? "present" : "missing"}`,
);

check(
  "MESSENGER",
  present(env.MESSENGER_PAGE_ACCESS_TOKEN) || present(env.PAGE_ACCESS_TOKEN) || present(env.META_PAGE_ACCESS_TOKEN),
  `page token=${present(env.MESSENGER_PAGE_ACCESS_TOKEN) || present(env.PAGE_ACCESS_TOKEN) || present(env.META_PAGE_ACCESS_TOKEN) ? "present" : "missing"}`,
);

check(
  "INSTAGRAM",
  (present(env.INSTAGRAM_ACCESS_TOKEN) || present(env.META_ACCESS_TOKEN)) &&
    (present(env.INSTAGRAM_BUSINESS_ACCOUNT_ID) || present(env.INSTAGRAM_ACCOUNT_ID)),
  `businessId=${(present(env.INSTAGRAM_BUSINESS_ACCOUNT_ID) || present(env.INSTAGRAM_ACCOUNT_ID)) ? mask(env.INSTAGRAM_BUSINESS_ACCOUNT_ID || env.INSTAGRAM_ACCOUNT_ID) : "missing"}, token=${present(env.INSTAGRAM_ACCESS_TOKEN) || present(env.META_ACCESS_TOKEN) ? "present" : "missing"}`,
);

check(
  "SMS",
  present(env.TWILIO_ACCOUNT_SID) &&
    present(env.TWILIO_AUTH_TOKEN) &&
    (present(env.TWILIO_DEFAULT_FROM) || present(env.TWILIO_MESSAGING_SERVICE_SID) || present(env.TWILIO_PHONE_NUMBER)),
  `sid=${present(env.TWILIO_ACCOUNT_SID) ? mask(env.TWILIO_ACCOUNT_SID) : "missing"}, from=${present(env.TWILIO_DEFAULT_FROM) || present(env.TWILIO_PHONE_NUMBER) ? "present" : "missing"}, svc=${present(env.TWILIO_MESSAGING_SERVICE_SID) ? "present" : "missing"}, statusCallback=${present(env.TWILIO_SMS_STATUS_CALLBACK_URL) ? "present" : present(env.API_PUBLIC_URL) ? "present-by-public-url" : "missing"}`,
);

check(
  "WEBSITE_CHAT",
  present(env.WEBSITE_CHAT_WEBHOOK_URL),
  `webhook=${present(env.WEBSITE_CHAT_WEBHOOK_URL) ? env.WEBSITE_CHAT_WEBHOOK_URL : "missing"}`,
);

check(
  "META_WEBHOOK_VERIFY",
  present(env.META_VERIFY_TOKEN),
  `metaVerifyToken=${present(env.META_VERIFY_TOKEN) ? "present" : "missing"}, pages=${present(env.WEB_ORIGIN) ? "present" : "missing"}`,
);

check(
  "EMAIL",
  (present(env.RESEND_API_KEY) && present(env.RESEND_FROM || env.EMAIL_FROM_ADDRESS)) || present(env.EMAIL_WEBHOOK_URL),
  `resend=${present(env.RESEND_API_KEY) && present(env.RESEND_FROM || env.EMAIL_FROM_ADDRESS) ? "present" : "missing"}, fallbackWebhook=${present(env.EMAIL_WEBHOOK_URL) ? "present" : "missing"}`,
);

check(
  "PHONE",
  present(env.TWILIO_ACCOUNT_SID) &&
    present(env.TWILIO_AUTH_TOKEN) &&
    (present(env.TWILIO_VOICE_FROM) || present(env.TWILIO_DEFAULT_FROM) || present(env.TWILIO_PHONE_NUMBER)),
  `voiceFrom=${present(env.TWILIO_VOICE_FROM) || present(env.TWILIO_DEFAULT_FROM) || present(env.TWILIO_PHONE_NUMBER) ? "present" : "missing"}, `
    + `voiceCallback=${present(env.TWILIO_VOICE_CALLBACK_URL) ? "present" : present(env.API_PUBLIC_URL) ? "present-by-public-url" : "missing"}, `
    + `statusCallback=${present(env.TWILIO_VOICE_STATUS_CALLBACK_URL) ? "present" : present(env.API_PUBLIC_URL) ? "present-by-public-url" : "missing"}`,
);

check(
  "TWILIO_CALLBACKS",
  (present(env.TWILIO_SMS_STATUS_CALLBACK_URL) || present(env.API_PUBLIC_URL)) &&
    (present(env.TWILIO_VOICE_CALLBACK_URL) || present(env.API_PUBLIC_URL)) &&
    (present(env.TWILIO_VOICE_STATUS_CALLBACK_URL) || present(env.API_PUBLIC_URL)),
  `smsStatusCallback=${present(env.TWILIO_SMS_STATUS_CALLBACK_URL) ? env.TWILIO_SMS_STATUS_CALLBACK_URL : present(env.API_PUBLIC_URL) ? `${env.API_PUBLIC_URL}/api/webhooks/twilio/status` : "missing"}, `
    + `voiceIncoming=${present(env.TWILIO_VOICE_CALLBACK_URL) ? env.TWILIO_VOICE_CALLBACK_URL : env.API_PUBLIC_URL ? `${env.API_PUBLIC_URL}/api/twilio/incoming` : "missing"}, `
    + `voiceStatus=${present(env.TWILIO_VOICE_STATUS_CALLBACK_URL) ? env.TWILIO_VOICE_STATUS_CALLBACK_URL : env.API_PUBLIC_URL ? `${env.API_PUBLIC_URL}/api/twilio/status` : "missing"}`,
);

console.log();
console.log("Tip: For runtime verification, send a test message from each conversation in Inbox and confirm outbound status updates.");
