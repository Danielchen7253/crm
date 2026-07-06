import fs from "node:fs";
import path from "node:path";

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
  return Boolean(value && String(value).trim().length > 0);
}

const envPath = path.join(process.cwd(), ".env");
const env = { ...readEnv(envPath), ...process.env };
const base = process.argv[2] ?? env.API_BASE_URL ?? "https://coolfix-omni-api.onrender.com";
const metaToken =
  process.argv[3] ??
  env.META_VERIFY_TOKEN ??
  env.META_WEBHOOK_VERIFY_TOKEN ??
  env.META_VERIFY ??
  env.WEBHOOK_VERIFY_TOKEN ??
  env.WEB_ORIGIN_VERIFY_TOKEN ??
  env.VERIFY_TOKEN ??
  "__MISSING__";

const checks = [
  {
    name: "meta_verify",
    method: "GET",
    path: `/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(metaToken)}&hub.challenge=ok`,
    expectStatus: 200,
    expectBody: "ok",
  },
  {
    name: "messenger_verify",
    method: "GET",
    path: `/api/webhooks/messenger?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(metaToken)}&hub.challenge=ok`,
    expectStatus: 200,
    expectBody: "ok",
  },
  {
    name: "whatsapp_verify",
    method: "GET",
    path: `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(metaToken)}&hub.challenge=ok`,
    expectStatus: 200,
    expectBody: "ok",
  },
  {
    name: "instagram_verify",
    method: "GET",
    path: `/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(metaToken)}&hub.challenge=ok`,
    expectStatus: 200,
    expectBody: "ok",
  },
  {
    name: "website_chat_get_legacy_underscore",
    method: "GET",
    path: `/api/webhooks/website_chat?x=1`,
    expectStatus: 200,
    expectBody: "invalid",
  },
  {
    name: "website_chat_get_dash",
    method: "GET",
    path: `/api/webhooks/website-chat?x=1`,
    expectStatus: 200,
    expectBody: "invalid",
  },
  {
    name: "twilio_status_post",
    method: "POST",
    path: `/api/webhooks/twilio/status`,
    body: { MessageSid: "verify-verify", MessageStatus: "sent" },
    headers: { "Content-Type": "application/json" },
    expectStatus: [200, 201],
  },
  {
    name: "twilio_status_alias_post",
    method: "POST",
    path: `/api/twilio/status`,
    body: { CallSid: "verify-verify-alias", CallStatus: "completed", CallDuration: "5" },
    headers: { "Content-Type": "application/json" },
    expectStatus: [200, 201],
  },
  {
    name: "twilio_sms_post_legacy",
    method: "POST",
    path: `/api/webhooks/twilio/incoming`,
    body: { MessageSid: "verify-sms", From: "+123", To: "+456", Body: "verify" },
    headers: { "Content-Type": "application/json" },
    expectStatus: [200, 201],
    expectJson: true,
  },
  {
    name: "twilio_sms_post",
    method: "POST",
    path: `/api/webhooks/twilio/sms`,
    body: { MessageSid: "verify-sms-2", From: "+123", To: "+456", Body: "verify" },
    headers: { "Content-Type": "application/json" },
    expectStatus: [200, 201],
    expectJson: true,
  },
  {
    name: "voice_incoming_endpoint",
    method: "POST",
    path: `/api/twilio/incoming`,
    body: { From: "+123", To: "+456", CallSid: "CA" + Date.now() },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    expectStatus: [200, 201],
  },
  {
    name: "twilio_voice_incoming_alias_to_webhook",
    method: "POST",
    path: `/api/webhooks/twilio/incoming`,
    body: { From: "+123", To: "+456", CallSid: "CA" + Date.now() },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    expectStatus: [200, 201],
  },
];

function isJsonText(contentType = "") {
  return contentType.includes("application/json") || contentType.includes("application/problem+json");
}

async function fetchChannelAccounts(urlBase) {
  try {
    const response = await fetch(`${urlBase.replace(/\/$/, "")}/api/channel-accounts`);
    const text = await response.text();
    if (!response.ok) return { ok: false, reason: `status ${response.status}`, text };
    const accounts = text ? JSON.parse(text) : [];
    return { ok: true, accounts: Array.isArray(accounts) ? accounts : [] };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function runCheck(check) {
  const init = {
    method: check.method,
    headers: check.headers,
    redirect: "manual",
  };
  if (check.body) {
    const contentType = (check.headers?.["Content-Type"] || "").toLowerCase();
    if (contentType.includes("application/x-www-form-urlencoded")) {
      init.body = new URLSearchParams(check.body).toString();
    } else {
      init.body = JSON.stringify(check.body);
    }
  }

  const url = `${base.replace(/\/$/, "")}${check.path}`;
  const result = { name: check.name, ok: false, status: undefined, body: undefined };
  try {
    const response = await fetch(url, init);
    result.status = response.status;
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (isJsonText(contentType)) {
      const data = await response.text();
      result.body = data;
      if (check.expectJson) {
        try {
          JSON.parse(data);
        } catch {
          result.error = "response_not_json";
        }
      }
    } else {
      result.body = await response.text();
    }

    const expectStatus = Array.isArray(check.expectStatus) ? check.expectStatus : [check.expectStatus];
    const statusOk = expectStatus.includes(response.status);
    const bodyText = typeof result.body === "string" ? result.body.trim() : "";
    const bodyOk =
      check.expectBody == null
        ? true
        : check.expectBody === ""
          ? response.headers.get("allow") !== null && response.status === 405
          : bodyText === check.expectBody;
    result.ok = statusOk && bodyOk && !result.error;
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

async function runWhatsAppHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/webhooks/whatsapp/health`);
    const text = await response.text();
    if (!response.ok) {
      console.log(`whatsapp_health: FAIL status=${response.status} body=${text}`);
      return;
    }
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    const graphOk = Boolean(parsed.graphOk);
    const line = `whatsapp_health: ${graphOk ? "OK" : "FAIL"} graphOk=${parsed.graphOk} error=${parsed.error || "none"} code=${parsed.errorCode || "n/a"}`;
    console.log(line);
  } catch (error) {
    console.log(`whatsapp_health: FAIL ${error.message}`);
  }
}

(async () => {
  console.log(`Verifying API channels at ${base}`);
  if (metaToken === "__MISSING__") {
    console.log("WARNING: META_VERIFY_TOKEN missing. messenger/whatsapp/instagram verify checks may return invalid.");
  }
  if (!present(env.API_BASE_URL) && !process.env.API_BASE_URL) {
    console.log("INFO: API_BASE_URL not set in env; using default render endpoint.");
  }

  const accountsReport = await fetchChannelAccounts(base);
  if (!accountsReport.ok) {
    console.log(`channel-accounts: FAIL (${accountsReport.reason})`);
  } else {
    const byChannel = {};
    for (const account of accountsReport.accounts) {
      const channel = account?.channel;
      if (!channel) continue;
      byChannel[channel] = (byChannel[channel] ?? 0) + (account.isActive ? 1 : 0);
    }
    const keys = ["whatsapp", "messenger", "instagram", "sms", "website_chat", "email", "phone"];
    const channelSummary = keys
      .map((key) => `${key}:${byChannel[key] ?? 0}`)
      .join(" | ");
    console.log(`channel-accounts(active): ${channelSummary}`);
  }

  await runWhatsAppHealth(base);

  let pass = 0;
  let fail = 0;

  for (const check of checks) {
    const result = await runCheck(check);
    if (result.ok) pass++;
    else fail++;
    const status = result.ok ? "OK" : "FAIL";
    const bodyLine = result.body ? ` body=${String(result.body).slice(0, 180)}` : "";
    console.log(`${status.padEnd(5)} ${result.name}: ${result.status}${bodyLine}${result.error ? ` error=${result.error}` : ""}`);
  }
  console.log(`\nDone. pass=${pass}, fail=${fail}`);
  if (fail > 0) process.exitCode = 1;
})();
