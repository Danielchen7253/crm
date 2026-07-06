import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const NODE_BINARY = process.execPath;
const envFile = { ...readEnv(path.join(process.cwd(), ".env")), ...process.env };
const args = process.argv.slice(2).filter((arg) => arg.trim());
const allowPartial = args.includes("--partial");
const metaTokenArg = args.find((arg) => arg.startsWith("--meta-token="));
const explicitMetaToken = metaTokenArg ? metaTokenArg.split("=", 2)[1] : "";
const API_BASE =
  args.find((arg) => !arg.startsWith("--") && !/^\w+=/.test(arg)) ||
  envFile.API_BASE ||
  envFile.API_URL ||
  process.env.API_BASE ||
  process.env.API_URL ||
  "https://coolfix-omni-api.onrender.com";

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

function readValue(env, keys) {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function present(value) {
  return Boolean(value && String(value).trim().length > 0);
}



const META_VERIFY_TOKEN =
  explicitMetaToken ||
  (
    envFile.META_VERIFY_TOKEN ??
    envFile.META_WEBHOOK_VERIFY_TOKEN ??
    envFile.META_VERIFY ??
    envFile.WEBHOOK_VERIFY_TOKEN ??
    envFile.WEB_ORIGIN_VERIFY_TOKEN ??
    envFile.VERIFY_TOKEN ??
    process.env.META_VERIFY_TOKEN ??
    process.env.META_WEBHOOK_VERIFY_TOKEN ??
    process.env.META_VERIFY ??
    process.env.WEBHOOK_VERIFY_TOKEN ??
    process.env.WEB_ORIGIN_VERIFY_TOKEN ??
    process.env.VERIFY_TOKEN
  );

const required = {
  "Meta Verify": [ "META_VERIFY_TOKEN || META_WEBHOOK_VERIFY_TOKEN || META_VERIFY || WEBHOOK_VERIFY_TOKEN || WEB_ORIGIN_VERIFY_TOKEN || VERIFY_TOKEN" ],
  "WhatsApp": [ "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID" ],
  "Messenger": [ "MESSENGER_PAGE_ACCESS_TOKEN || PAGE_ACCESS_TOKEN || META_PAGE_ACCESS_TOKEN" ],
  "Instagram": [ "INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_BUSINESS_ACCOUNT_ID" ],
  "Twilio": [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_DEFAULT_FROM || TWILIO_PHONE_NUMBER || TWILIO_FROM_NUMBER || TWILIO_VOICE_FROM",
  ],
  "Website Chat": [ "WEBSITE_CHAT_WEBHOOK_URL" ],
  "Email": [ "RESEND_API_KEY OR RESEND_FROM", "EMAIL_WEBHOOK_URL" ],
  "Webhook/Public URL": [ "API_PUBLIC_URL" ],
};

const alt = {
  MESSENGER_PAGE_ACCESS_TOKEN: [ "PAGE_ACCESS_TOKEN", "META_PAGE_ACCESS_TOKEN" ],
  WHATSAPP_ACCESS_TOKEN: [ "META_ACCESS_TOKEN" ],
  INSTAGRAM_ACCESS_TOKEN: [ "META_ACCESS_TOKEN" ],
  TWILIO_DEFAULT_FROM: [ "TWILIO_PHONE_NUMBER", "TWILIO_FROM_NUMBER" ],
};

function readEnvValue(keys, source = envFile) {
  for (const key of keys) {
    const value = source[key];
    if (value && value.trim()) return value;
  }
  return "";
}

function isMissing(name, candidates) {
  const present = candidates.find((key) => {
    if (key.includes("||")) {
      const parts = key.split("||").map((x) => x.trim());
      return parts.some((part) => readEnvValue([part]));
    }
    if (key.includes("OR")) {
      const parts = key.split("OR").map((x) => x.trim());
      return parts.some((part) => readEnvValue([part]));
    }
    return readEnvValue([key]);
  });
  return !present;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(code);
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function checkConfig() {
  const issues = [];

  for (const [group, keys] of Object.entries(required)) {
    const missing = keys.filter((key) => isMissing(key, [key]));
    if (missing.length) {
      issues.push({
        group,
        missing,
      });
    }
  }

  const whatsappAlt = readEnvValue([ "WHATSAPP_ACCESS_TOKEN", "META_ACCESS_TOKEN" ], envFile);
  const messengerAlt = readEnvValue([ "MESSENGER_PAGE_ACCESS_TOKEN", "PAGE_ACCESS_TOKEN", "META_PAGE_ACCESS_TOKEN" ], envFile);
  const instagramAlt = readEnvValue([ "INSTAGRAM_ACCESS_TOKEN", "META_ACCESS_TOKEN" ], envFile);
  const twilioFrom = readEnvValue([ "TWILIO_DEFAULT_FROM", "TWILIO_PHONE_NUMBER", "TWILIO_FROM_NUMBER", "TWILIO_VOICE_FROM" ], envFile);

  if (!whatsappAlt) issues.push({ group: "WhatsApp token", missing: [ "WHATSAPP_ACCESS_TOKEN / META_ACCESS_TOKEN" ] });
  if (!messengerAlt) issues.push({ group: "Messenger token", missing: [ "MESSENGER_PAGE_ACCESS_TOKEN / PAGE_ACCESS_TOKEN / META_PAGE_ACCESS_TOKEN" ] });
  if (!instagramAlt) issues.push({ group: "Instagram token", missing: [ "INSTAGRAM_ACCESS_TOKEN / META_ACCESS_TOKEN" ] });
  if (!twilioFrom) issues.push({ group: "Twilio From", missing: [ "TWILIO_DEFAULT_FROM / TWILIO_PHONE_NUMBER / TWILIO_FROM_NUMBER / TWILIO_VOICE_FROM" ] });
  const emailResendApiKey = readEnvValue([ "RESEND_API_KEY" ], envFile);
  const emailResendFrom = readEnvValue([ "RESEND_FROM", "EMAIL_FROM_ADDRESS" ], envFile);
  const emailWebhook = readEnvValue([ "EMAIL_WEBHOOK_URL" ], envFile);
  if (!(present(emailResendApiKey) && present(emailResendFrom)) && !present(emailWebhook)) {
    issues.push({ group: "Email", missing: [ "RESEND_API_KEY + RESEND_FROM/EMAIL_FROM_ADDRESS or EMAIL_WEBHOOK_URL" ] });
  }

  if (issues.length) {
    if (allowPartial) {
      console.log("repair-channels: some env vars missing; continuing in partial mode");
      for (const issue of issues) {
        console.log(`- ${issue.group}: ${issue.missing.join(", ")}`);
      }
      console.log("Available credentials will be synced; missing channels remain disabled until fixed.\n");
      return true;
    }

    console.log("repair-channels: missing critical env config");
    for (const issue of issues) {
      console.log(`- ${issue.group}: ${issue.missing.join(", ")}`);
    }
    console.log("Set required environment vars and rerun this script.");
    return false;
  }

  return true;
}

async function run() {
  console.log(`[repair-channels] API_BASE=${API_BASE}`);
  if (!checkConfig()) process.exit(1);

  console.log("\n[repair-channels] Syncing channel accounts...");
  const syncArgs = [ "scripts/sync-channel-accounts.mjs", API_BASE ];
  if (allowPartial) syncArgs.push("--partial");
  await runCommand(NODE_BINARY, syncArgs);

  console.log("\n[repair-channels] Verifying live channels...");
  await runCommand(NODE_BINARY, [ "scripts/verify-live-channels.mjs", API_BASE, META_VERIFY_TOKEN ]);

  console.log("\n[repair-channels] Repairing dirty Meta IDs (messenger/instagram/whatsapp)...");
  await runCommand(NODE_BINARY, [ "scripts/repair-meta-conversations.mjs", API_BASE, "--channels=messenger,instagram,whatsapp" ]);

  console.log("\n[repair-channels] Completed. If any fail, update env and rerun.");
}

run().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
