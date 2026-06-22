import { PrismaClient, Channel, MessageDirection, MessageStatus, MessageType } from "@prisma/client";

const prisma = new PrismaClient();

type LegacyCustomer = {
  id: string | number;
  name?: string;
  phone?: string;
  email?: string;
  source?: string;
  avatar_url?: string;
  created_at?: string;
};

type LegacyMessage = {
  id: string | number;
  customer_id?: string | number;
  conversation_id?: string | number;
  channel?: string;
  direction?: string;
  message_text?: string;
  text?: string;
  external_message_id?: string;
  created_at?: string;
  raw_payload?: unknown;
};

async function main() {
  const legacyApi = process.env.LEGACY_SUPABASE_URL;
  const legacyKey = process.env.LEGACY_SUPABASE_SERVICE_ROLE_KEY;

  if (!legacyApi || !legacyKey) {
    throw new Error("Set LEGACY_SUPABASE_URL and LEGACY_SUPABASE_SERVICE_ROLE_KEY before migrating.");
  }

  const customers = await fetchLegacy<LegacyCustomer[]>(legacyApi, legacyKey, "customers?select=*");
  const customerIdMap = new Map<string, string>();

  for (const legacy of customers) {
    const customer = await prisma.customer.create({
      data: {
        displayName: legacy.name ?? legacy.phone ?? legacy.email ?? `Legacy customer ${legacy.id}`,
        primaryPhone: normalizePhone(legacy.phone),
        primaryEmail: legacy.email?.trim().toLowerCase(),
        source: toChannel(legacy.source),
        avatarUrl: legacy.avatar_url,
        metadata: { legacyId: legacy.id },
        createdAt: legacy.created_at ? new Date(legacy.created_at) : undefined,
      },
    });
    customerIdMap.set(String(legacy.id), customer.id);
  }

  const messages = await fetchLegacy<LegacyMessage[]>(legacyApi, legacyKey, "messages?select=*");
  for (const legacy of messages) {
    const customerId = legacy.customer_id ? customerIdMap.get(String(legacy.customer_id)) : undefined;
    if (!customerId) continue;

    const channel = toChannel(legacy.channel) ?? Channel.website_chat;
    const externalThreadId = legacy.conversation_id ? `legacy:${legacy.conversation_id}` : `legacy-customer:${legacy.customer_id}`;
    const conversation = await prisma.conversation.upsert({
      where: { channel_externalThreadId: { channel, externalThreadId } },
      update: { lastMessageAt: legacy.created_at ? new Date(legacy.created_at) : undefined },
      create: {
        customerId,
        channel,
        externalThreadId,
        status: "open",
        lastMessageAt: legacy.created_at ? new Date(legacy.created_at) : undefined,
      },
    });

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        customerId,
        channel,
        provider: "legacy-flask",
        externalMessageId: legacy.external_message_id ? String(legacy.external_message_id) : undefined,
        fallbackDedupeKey: legacy.external_message_id ? undefined : `legacy:${legacy.id}`,
        direction: legacy.direction === "outbound" ? MessageDirection.outbound : MessageDirection.inbound,
        type: MessageType.text,
        status: MessageStatus.received,
        text: legacy.message_text ?? legacy.text,
        rawEvent: (legacy.raw_payload ?? { legacyId: legacy.id }) as object,
        sentAt: legacy.created_at ? new Date(legacy.created_at) : new Date(),
      },
    });
  }

  console.log(`Migrated ${customerIdMap.size} customers and ${messages.length} legacy messages.`);
}

async function fetchLegacy<T>(baseUrl: string, key: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
  if (!response.ok) throw new Error(`Legacy fetch failed ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

function toChannel(value?: string): Channel | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace("-", "_");
  if (Object.values(Channel).includes(normalized as Channel)) return normalized as Channel;
  if (normalized.includes("facebook")) return Channel.messenger;
  if (normalized.includes("wa")) return Channel.whatsapp;
  if (normalized.includes("text")) return Channel.sms;
  return undefined;
}

function normalizePhone(phone?: string) {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, "");
  if (!digits) return undefined;
  return digits.length === 10 ? `1${digits}` : digits;
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => prisma.$disconnect());
