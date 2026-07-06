import { spawn } from "node:child_process";
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

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    baseUrl: null,
    send: args.includes("--send"),
    skipSend: args.includes("--skip-send"),
    verifyOnly: args.includes("--verify-only"),
    skipMetaRepair: args.includes("--skip-meta-repair"),
    partial: args.includes("--partial"),
    token: null,
  };

  for (const arg of args) {
    if (!arg.startsWith("--") && !options.baseUrl) {
      options.baseUrl = arg;
      continue;
    }

    if (arg.startsWith("--meta-token=")) {
      options.token = arg.split("=", 2)[1];
    }
  }

  return options;
}

function runNodeScript(script, args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: "inherit",
      env: { ...process.env, ...extraEnv },
    });

    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

function resolveEnvToken(envFromFile) {
  return (
    envFromFile.META_VERIFY_TOKEN ??
    envFromFile.META_WEBHOOK_VERIFY_TOKEN ??
    envFromFile.META_VERIFY ??
    envFromFile.WEBHOOK_VERIFY_TOKEN ??
    envFromFile.WEB_ORIGIN_VERIFY_TOKEN ??
    envFromFile.VERIFY_TOKEN ??
    envFromFile.META_WEB_ORIGIN_VERIFY_TOKEN ??
    process.env.META_VERIFY_TOKEN ??
    process.env.META_WEBHOOK_VERIFY_TOKEN ??
    process.env.META_VERIFY ??
    process.env.WEBHOOK_VERIFY_TOKEN ??
    process.env.WEB_ORIGIN_VERIFY_TOKEN ??
    process.env.VERIFY_TOKEN
  );
}

async function run() {
  const options = parseArgs();
  const envFile = readEnv(path.join(process.cwd(), ".env"));
  const base = options.baseUrl ?? envFile.API_BASE_URL ?? envFile.API_URL ?? "https://coolfix-omni-api.onrender.com";
  const metaToken = options.token ?? resolveEnvToken(envFile);

  console.log("== CRM channel recovery run ==");
  console.log(`baseUrl=${base}`);
  console.log(`metaToken=${metaToken ? "present" : "missing"}`);
  console.log(`send=${options.send ? "on" : "off"}`);
  console.log();

  if (!options.verifyOnly) {
    console.log("[1/4] check-channel-config");
    const checkCode = await runNodeScript("scripts/check-channel-config.mjs");
    if (checkCode !== 0) {
      console.log("check-channel-config reported missing config. You may still continue, but sync/verify will stop on missing required env.");
    }
  }

  console.log("[2/4] sync-channel-accounts");
  const syncArgs = [base];
  if (options.partial) syncArgs.push("--partial");
  const syncCode = await runNodeScript("scripts/sync-channel-accounts.mjs", syncArgs);
  if (syncCode !== 0) {
    console.log("sync-channel-accounts failed. Fix env vars listed above and rerun.");
    process.exit(syncCode);
  }

  if (!options.skipMetaRepair) {
    console.log("[3/5] repair-meta-conversations");
    const repairCode = await runNodeScript("scripts/repair-meta-conversations.mjs", [base, "--channels=messenger,instagram,whatsapp"]);
    if (repairCode !== 0) {
      console.log("repair-meta-conversations reported errors. Continuing with verify/smoke may still work for existing conversations.");
    }
  }

  console.log("[4/5] verify-live-channels");
  const verifyCode = await runNodeScript("scripts/verify-live-channels.mjs", [base, metaToken ?? ""]);
  if (verifyCode !== 0) {
    console.log("verify-live-channels reported failures. See output and fix remaining provider config.");
  }

  const shouldSend = options.send && !options.skipSend;
  const smokeArgs = ["scripts/smoke-channel-send.mjs", base];
  if (shouldSend) smokeArgs.push("--send");

  console.log(`[5/5] smoke-channel-send (${shouldSend ? "send enabled" : "dry-run"})`);
  const smokeCode = await runNodeScript("scripts/smoke-channel-send.mjs", smokeArgs.slice(1));

  if (verifyCode !== 0 || syncCode !== 0 || smokeCode !== 0) {
    process.exit(1);
  }

  console.log("Recovery run completed.");
}

run().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
