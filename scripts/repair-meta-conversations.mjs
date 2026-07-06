import fs from "node:fs";
import path from "node:path";

const cliArgs = process.argv.slice(2);
const API_BASE = cliArgs.find((arg) => !arg.startsWith("--")) ?? process.env.API_BASE_URL ?? process.env.API_PUBLIC_URL ?? "https://coolfix-omni-api.onrender.com";

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

function pickChannels() {
  const explicit = cliArgs.find((arg) => arg.startsWith("--channels="))?.split("=", 2)?.[1];
  if (!explicit) return ["messenger", "instagram", "whatsapp"];
  return explicit
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value === "messenger" || value === "instagram" || value === "whatsapp");
}

async function run() {
  const env = readEnv(path.join(process.cwd(), ".env"));
  const base = (process.env.API_BASE_URL ?? env.API_BASE_URL ?? API_BASE).replace(/\/$/, "");
  const channels = pickChannels();
  const body = { channels };

  const response = await fetch(`${base}/api/admin/messenger/repair-conversations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  let result = responseText;
  try {
    result = responseText ? JSON.parse(responseText) : {};
  } catch {
    // keep raw text
  }

  console.log(`repair-meta-conversations base=${base}`);
  console.log(`channels=${channels.join(",")}`);
  console.log(response.ok ? `status=OK ${response.status}` : `status=FAIL ${response.status}`);
  console.log(`result=${typeof result === "string" ? result : JSON.stringify(result)}`);

  if (!response.ok) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
