import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.resolve("packages/database/package.json"));
const { PrismaClient, Channel, MessageDirection, MessageStatus, MessageType } = require("@prisma/client");
const prisma = new PrismaClient();

const args = new Set(process.argv.slice(2));
const execute = args.has("--execute");
const includeBuyer = args.has("--include-buyer");
const inputDir = valueArg("--dir") ?? "tmp-facebook-marketplace";
const ownerName = valueArg("--owner") ?? "Daniel Chen";

function valueArg(name) {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function readFacebookJson(filePath) {
  const buffer = fs.readFileSync(filePath);
  const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? "utf16le" : "utf8";
  const text = buffer.toString(encoding).replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

function labelValue(entry, index) {
  const item = entry?.label_values?.[index];
  return typeof item?.value === "string" ? item.value.trim() : undefined;
}

function labelTimestamp(entry, index) {
  const item = entry?.label_values?.[index];
  return Number(item?.timestamp_value || entry.timestamp || 0) || undefined;
}

function normalizeName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function identityKey(name) {
  return normalizeName(name).toLowerCase().replace(/[^a-z0-9\u00c0-\uffff]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

function toDate(seconds) {
  return seconds ? new Date(seconds * 1000) : new Date();
}

function asRecord(entry, role) {
  const title = labelValue(entry, 0) ?? "Facebook Marketplace inquiry";
  const updated = labelTimestamp(entry, 1) ?? entry.timestamp;
  const buyer = normalizeName(labelValue(entry, 2));
  const seller = normalizeName(labelValue(entry, 3));
  const customerName = role === "seller" ? buyer : seller;
  if (!customerName || customerName === ownerName) return null;
  const fbid = String(entry.fbid ?? `${role}:${customerName}:${updated}`);
  return {
    role,
    fbid,
    title,
    customerName,
    ownerName,
    sentAt: toDate(updated),
    startedAt: toDate(entry.timestamp),
  };
}

async function ensureTag(name, groupName, color) {
  return prisma.tag.upsert({
    where: { name },
    update: { groupName, color, isActive: true },
    create: { name, groupName, color, isActive: true },
  });
}

async function ensureCustomerTag(customerId, tagId) {
  await prisma.customerTag
    .upsert({
      where: { customerId_tagId: { customerId, tagId } },
      update: {},
      create: { customerId, tagId },
    })
    .catch(() => undefined);
}

async function importRecord(record, tags) {
  const externalIdentityId = `marketplace-name:${identityKey(record.customerName)}`;
  const identity = await prisma.customerIdentity.findUnique({
    where: { provider_externalId: { provider: "facebook_marketplace", externalId: externalIdentityId } },
    include: { customer: true },
  });

  const customer =
    identity?.customer ??
    (await prisma.customer.create({
      data: {
        displayName: record.customerName,
        source: Channel.messenger,
        lastMessageAt: record.sentAt,
        lastContactAt: record.sentAt,
        metadata: {
          importedFrom: "facebook_marketplace_export",
          importedBy: "import-facebook-marketplace",
        },
      },
    }));

  if (!identity) {
    await prisma.customerIdentity.create({
      data: {
        customerId: customer.id,
        channel: Channel.messenger,
        provider: "facebook_marketplace",
        externalId: externalIdentityId,
        displayName: record.customerName,
        lastSeenAt: record.sentAt,
        rawProfile: {
          source: "facebook_marketplace_export",
          role: record.role,
        },
      },
    });
  }

  for (const tag of tags) await ensureCustomerTag(customer.id, tag.id);

  const externalThreadId = `marketplace:${record.fbid}`;
  const conversation = await prisma.conversation.upsert({
    where: { channel_externalThreadId: { channel: Channel.messenger, externalThreadId } },
    update: {
      customerId: customer.id,
      lastMessageAt: record.sentAt,
      metadata: {
        source: "facebook_marketplace_export",
        role: record.role,
        fbid: record.fbid,
        listingTitle: record.title,
      },
    },
    create: {
      customerId: customer.id,
      channel: Channel.messenger,
      externalThreadId,
      status: "new",
      lastMessageAt: record.sentAt,
      metadata: {
        source: "facebook_marketplace_export",
        role: record.role,
        fbid: record.fbid,
        listingTitle: record.title,
      },
    },
  });

  const text =
    record.role === "seller"
      ? `Facebook Marketplace inquiry about: ${record.title}`
      : `Facebook Marketplace contact you messaged about: ${record.title}`;

  await prisma.message.upsert({
    where: { fallbackDedupeKey: `facebook-marketplace:${record.role}:${record.fbid}` },
    update: {},
    create: {
      conversationId: conversation.id,
      customerId: customer.id,
      channel: Channel.messenger,
      provider: "facebook-marketplace-export",
      externalConversationId: externalThreadId,
      fallbackDedupeKey: `facebook-marketplace:${record.role}:${record.fbid}`,
      senderType: record.role === "seller" ? "customer" : "agent",
      direction: record.role === "seller" ? MessageDirection.inbound : MessageDirection.outbound,
      type: MessageType.text,
      contentType: MessageType.text,
      status: record.role === "seller" ? MessageStatus.received : MessageStatus.sent,
      text,
      textContent: text,
      rawEvent: {
        source: "facebook_marketplace_export",
        role: record.role,
        fbid: record.fbid,
        listingTitle: record.title,
        customerName: record.customerName,
      },
      sentAt: record.sentAt,
    },
  });

  await prisma.customer.update({
    where: { id: customer.id },
    data: { lastMessageAt: record.sentAt, lastContactAt: record.sentAt },
  });
}

async function main() {
  const files = [{ role: "seller", file: path.join(inputDir, "seller.json") }];
  if (includeBuyer) files.push({ role: "buyer", file: path.join(inputDir, "buyer.json") });

  const records = [];
  for (const item of files) {
    if (!fs.existsSync(item.file)) throw new Error(`Missing ${item.file}`);
    const rows = readFacebookJson(item.file);
    for (const row of rows) {
      const record = asRecord(row, item.role);
      if (record) records.push(record);
    }
  }

  const byThread = new Map();
  for (const record of records) byThread.set(`${record.role}:${record.fbid}`, record);
  const uniqueRecords = [...byThread.values()].sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  const uniqueCustomers = new Set(uniqueRecords.map((record) => record.customerName.toLowerCase()));

  console.log(
    JSON.stringify(
      {
        execute,
        inputDir,
        includeBuyer,
        records: uniqueRecords.length,
        uniqueCustomers: uniqueCustomers.size,
        newest: uniqueRecords[0]?.sentAt,
        oldest: uniqueRecords.at(-1)?.sentAt,
      },
      null,
      2,
    ),
  );

  if (!execute) {
    console.log("Dry run only. Add --execute to import.");
    return;
  }

  const tags = [
    await ensureTag("Marketplace Lead", "Marketing", "#2563eb"),
    await ensureTag("Facebook Lead", "Marketing", "#1877f2"),
  ];

  let imported = 0;
  for (const record of uniqueRecords) {
    await importRecord(record, tags);
    imported += 1;
    if (imported % 100 === 0) console.log(`Imported ${imported}/${uniqueRecords.length}`);
  }

  console.log(`Imported ${imported} Facebook Marketplace records.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
