const base = process.argv[2] ?? process.env.API_BASE_URL ?? "https://coolfix-omni-api.onrender.com";
const metaToken = process.argv[3] ?? process.env.META_VERIFY_TOKEN ?? "__MISSING__";

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
    expectStatus: 405,
    expectBody: "",
  },
  {
    name: "website_chat_get_dash",
    method: "GET",
    path: `/api/webhooks/website-chat?x=1`,
    expectStatus: 405,
    expectBody: "",
  },
  {
    name: "twilio_status_post",
    method: "POST",
    path: `/api/webhooks/twilio/status`,
    body: { MessageSid: "verify-verify", MessageStatus: "sent" },
    headers: { "Content-Type": "application/json" },
    expectStatus: 200,
  },
  {
    name: "twilio_sms_post_legacy",
    method: "POST",
    path: `/api/webhooks/twilio/incoming`,
    body: { MessageSid: "verify-sms", From: "+123", To: "+456", Body: "verify" },
    headers: { "Content-Type": "application/json" },
    expectStatus: 201,
    expectJson: true,
  },
  {
    name: "twilio_sms_post",
    method: "POST",
    path: `/api/webhooks/twilio/sms`,
    body: { MessageSid: "verify-sms-2", From: "+123", To: "+456", Body: "verify" },
    headers: { "Content-Type": "application/json" },
    expectStatus: 201,
    expectJson: true,
  },
  {
    name: "voice_incoming_endpoint",
    method: "POST",
    path: `/api/twilio/incoming`,
    body: { From: "+123", To: "+456", CallSid: "CA" + Date.now() },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    expectStatus: 200,
  },
  {
    name: "twilio_voice_incoming_alias_to_webhook",
    method: "POST",
    path: `/api/webhooks/twilio/incoming`,
    body: { From: "+123", To: "+456", CallSid: "CA" + Date.now() },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    expectStatus: 200,
  },
];

function isJsonText(contentType = "") {
  return contentType.includes("application/json") || contentType.includes("application/problem+json");
}

async function runCheck(check) {
  const init = {
    method: check.method,
    headers: check.headers,
    redirect: "manual",
  };
  if (check.body) {
    init.body = JSON.stringify(check.body);
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

    const statusOk = response.status === check.expectStatus;
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

(async () => {
  console.log(`Verifying API channels at ${base}`);
  if (metaToken === "__MISSING__") {
    console.log("WARNING: META_VERIFY_TOKEN missing. messenger/whatsapp/instagram verify checks may return invalid.");
  }
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
