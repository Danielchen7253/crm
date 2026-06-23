import { createHash } from "node:crypto";
import { PrismaClient, Channel, MessageDirection, MessageStatus, MessageType } from "@prisma/client";

const prisma = new PrismaClient();

const pageId = process.env.MESSENGER_PAGE_ID ?? "1071930952666440";
const token = process.env.MESSENGER_PAGE_ACCESS_TOKEN ?? process.env.PAGE_ACCESS_TOKEN ?? process.env.META_PAGE_ACCESS_TOKEN;
const graphVersion = process.env.META_GRAPH_VERSION ?? "v25.0";
const maxConversations = Number(process.env.MESSENGER_SYNC_LIMIT ?? "5000");
const maxMessagesPerConversation = Number(process.env.MESSENGER_SYNC_MESSAGES_PER_CONVERSATION ?? "50");

type GraphPage<T> = {
  data?: T[];
  paging?: { next?: string };
  error?: { message?: string; code?: number; type?: string };
};

type GraphConversation = {
  id: string;
  updated_time?: string;
  participants?: { data?: Array<{ id: string; name?: string; email?: string }> };
};

type GraphAttachment = {
  id?: string;
  name?: string;
  size?: number;
  mime_type?: string;
  file_url?: string;
  image_data?: { url?: string; preview_url?: string };
  video_data?: { url?: string; preview_url?: string };
};

type GraphMessage = {
  id: string;
  created_time?: string;
  from?: { id?: string; name?: string; email?: string };
  to?: { data?: Array<{ id?: string; name?: string; email?: string }> };
  message?: string;
  attachments?: { data?: GraphAttachment[] };
};

type Stats = {
  conversationsSeen: number;
  customersCreated: number;
  identitiesCreated: number;
  conversationsCreated: number;
  messagesCreated: number;
  messagesSkipped: number;
  errors: number;
};

const stats: Stats = {
  conversationsSeen: 0,
  customersCreated: 0,
  identitiesCreated: 0,
  conversationsCreated: 0,
  messagesCreated: 0,
  messagesSkipped: 0,
  errors: 0,
};

async function main() {
  if (!token) throw new Error("Missing MESSENGER_PAGE_ACCESS_TOKEN");

  const syncLog = await prisma.syncLog.create({
    data: {
      channel: Channel.messenger,
      syncType: "page_conversations_backfill",
      status: "running",
      metadata: { pageId, maxConversations, maxMessagesPerConversation },
    },
  });

  try {
    let url =
      `https://graph.facebook.com/${graphVersion}/${pageId}/conversations` +
      `?fields=id,updated_time,participants.limit(10){id,name,email}` +
      `&limit=100&access_token=${encodeURIComponent(token)}`;

    while (url && stats.conversationsSeen < maxConversations) {
      const page = await graph<GraphConversation>(url);
      for (const conversation of page.data ?? []) {
        if (stats.conversationsSeen >= maxConversations) break;
        stats.conversationsSeen += 1;
        await importConversation(conversation).catch((error) => {
          stats.errors += 1;
          console.error("conversation import failed", conversation.id, error instanceof Error ? error.message : error);
        });
      }
      url = page.paging?.next ?? "";
    }

    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: stats.errors ? "completed_with_errors" : "completed",
        finishedAt: new Date(),
        importedCustomersCount: stats.customersCreated,
        importedMessagesCount: stats.messagesCreated,
        metadata: { pageId, ...stats },
      },
    });

    console.log(JSON.stringify(stats, null, 2));
  } catch (error) {
    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : String(error),
        metadata: { pageId, ...stats },
      },
    });
    throw error;
  }
}

async function importConversation(conversation: GraphConversation) {
  const customerParticipant = (conversation.participants?.data ?? []).find((participant) => participant.id !== pageId);
  if (!customerParticipant?.id) return;

  const profile = await fetchMessengerProfile(customerParticipant.id).catch(() => undefined);
  const displayName = profile?.name ?? customerParticipant.name ?? "Facebook customer";
  const avatarUrl = profile?.profile_pic;
  const lastMessageAt = conversation.updated_time ? new Date(conversation.updated_time) : new Date();

  let identity = await prisma.customerIdentity.findUnique({
    where: { provider_externalId: { provider: "messenger", externalId: customerParticipant.id } },
    include: { customer: true },
  });

  if (!identity) {
    const customer = await prisma.customer.create({
      data: {
        displayName,
        primaryEmail: customerParticipant.email?.toLowerCase(),
        source: Channel.messenger,
        avatarUrl,
        lastMessageAt,
        lastContactAt: lastMessageAt,
        metadata: { messenger_psid: customerParticipant.id },
      },
    });
    stats.customersCreated += 1;
    identity = await prisma.customerIdentity.create({
      data: {
        customerId: customer.id,
        channel: Channel.messenger,
        provider: "messenger",
        externalId: customerParticipant.id,
        externalUserId: customerParticipant.id,
        email: customerParticipant.email?.toLowerCase(),
        displayName,
        avatarUrl,
        rawProfile: profile ?? customerParticipant,
        lastSeenAt: lastMessageAt,
      },
      include: { customer: true },
    });
    stats.identitiesCreated += 1;
  } else {
    await prisma.customer.update({
      where: { id: identity.customerId },
      data: {
        displayName: betterName(identity.customer.displayName, displayName),
        avatarUrl: identity.customer.avatarUrl ?? avatarUrl,
        lastMessageAt: maxDate(identity.customer.lastMessageAt, lastMessageAt),
        lastContactAt: maxDate(identity.customer.lastContactAt, lastMessageAt),
      },
    });
    await prisma.customerIdentity.update({
      where: { id: identity.id },
      data: {
        displayName: identity.displayName ?? displayName,
        avatarUrl: identity.avatarUrl ?? avatarUrl,
        rawProfile: profile ?? customerParticipant,
        lastSeenAt: lastMessageAt,
      },
    });
  }

  const existingConversation = await prisma.conversation.findUnique({
    where: { channel_externalThreadId: { channel: Channel.messenger, externalThreadId: conversation.id } },
  });
  const crmConversation =
    existingConversation ??
    (await prisma.conversation.create({
      data: {
        customerId: identity.customerId,
        identityId: identity.id,
        channel: Channel.messenger,
        externalThreadId: conversation.id,
        status: "open",
        lastMessageAt,
        metadata: { pageId },
      },
    }));

  if (!existingConversation) stats.conversationsCreated += 1;

  if (existingConversation && (!existingConversation.identityId || existingConversation.customerId !== identity.customerId)) {
    await prisma.conversation.update({
      where: { id: existingConversation.id },
      data: {
        customerId: identity.customerId,
        identityId: identity.id,
        lastMessageAt: maxDate(existingConversation.lastMessageAt, lastMessageAt),
      },
    });
  }

  await importMessages(conversation.id, crmConversation.id, identity.customerId, customerParticipant.id);
}

async function importMessages(graphConversationId: string, conversationId: string, customerId: string, customerPsid: string) {
  let imported = 0;
  let url =
    `https://graph.facebook.com/${graphVersion}/${graphConversationId}/messages` +
    `?fields=id,created_time,from,to,message,attachments.limit(10){id,name,size,mime_type,file_url,image_data,video_data}` +
    `&limit=25&access_token=${encodeURIComponent(token!)}`;

  while (url && imported < maxMessagesPerConversation) {
    const page = await graph<GraphMessage>(url);
    for (const message of page.data ?? []) {
      if (imported >= maxMessagesPerConversation) break;
      imported += 1;
      await importMessage(message, graphConversationId, conversationId, customerId, customerPsid);
    }
    url = page.paging?.next ?? "";
  }
}

async function importMessage(
  message: GraphMessage,
  graphConversationId: string,
  conversationId: string,
  customerId: string,
  customerPsid: string,
) {
  const existing = await prisma.message.findUnique({
    where: { channel_externalMessageId: { channel: Channel.messenger, externalMessageId: message.id } },
  });
  if (existing) {
    stats.messagesSkipped += 1;
    return;
  }

  const sentAt = message.created_time ? new Date(message.created_time) : new Date();
  const inbound = message.from?.id === customerPsid;
  const attachments = normalizeAttachments(message.attachments?.data ?? []);
  const type = attachments[0]?.type ?? MessageType.text;
  const text = message.message ?? (attachments.length ? `[Messenger ${type}]` : "");

  await prisma.message.create({
    data: {
      conversationId,
      customerId,
      channel: Channel.messenger,
      provider: "messenger",
      externalMessageId: message.id,
      externalConversationId: graphConversationId,
      senderExternalId: message.from?.id,
      senderType: inbound ? "customer" : "agent",
      direction: inbound ? MessageDirection.inbound : MessageDirection.outbound,
      type,
      contentType: type,
      status: inbound ? MessageStatus.received : MessageStatus.sent,
      text,
      textContent: text,
      contentHash: hash(text || JSON.stringify(attachments)),
      rawEvent: message,
      sentAt,
      attachments: {
        create: attachments.map((attachment) => ({
          type: attachment.type,
          url: attachment.url,
          fileUrl: attachment.url,
          mimeType: attachment.mimeType,
          fileName: attachment.fileName,
          sizeBytes: attachment.sizeBytes,
          externalMediaId: attachment.externalMediaId,
        })),
      },
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: sentAt },
  });
  await prisma.customer.update({
    where: { id: customerId },
    data: { lastMessageAt: sentAt, lastContactAt: sentAt },
  });

  stats.messagesCreated += 1;
}

function normalizeAttachments(items: GraphAttachment[]) {
  return items
    .map((item) => {
      const url = item.image_data?.url ?? item.video_data?.url ?? item.file_url;
      if (!url) return null;
      return {
        type: mediaType(item.mime_type, url),
        url,
        mimeType: item.mime_type,
        fileName: item.name,
        sizeBytes: item.size,
        externalMediaId: item.id,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function mediaType(mimeType?: string, url?: string) {
  const probe = `${mimeType ?? ""} ${url ?? ""}`.toLowerCase();
  if (probe.includes("image") || /\.(png|jpe?g|gif|webp|heic)([?#/]|$)/.test(probe)) return MessageType.image;
  if (probe.includes("audio") || /\.(mp3|m4a|wav|ogg|opus|aac)([?#/]|$)/.test(probe)) return MessageType.audio;
  if (probe.includes("video") || /\.(mp4|mov|webm|avi)([?#/]|$)/.test(probe)) return MessageType.video;
  return MessageType.file;
}

async function fetchMessengerProfile(psid: string): Promise<{ name?: string; profile_pic?: string } | undefined> {
  const url = `https://graph.facebook.com/${graphVersion}/${psid}?fields=first_name,last_name,name,profile_pic&access_token=${encodeURIComponent(token!)}`;
  const raw = await fetch(url).then((response) => response.json());
  if (raw.error) return undefined;
  return { name: raw.name ?? [raw.first_name, raw.last_name].filter(Boolean).join(" "), profile_pic: raw.profile_pic };
}

async function graph<T>(url: string): Promise<GraphPage<T>> {
  const response = await fetch(url);
  const json = (await response.json()) as GraphPage<T>;
  if (!response.ok || json.error) throw new Error(json.error?.message ?? response.statusText);
  return json;
}

function betterName(current?: string | null, incoming?: string) {
  if (!incoming) return current ?? undefined;
  if (!current || current === "New customer" || current === "Facebook customer" || current === "Facebook 用户") return incoming;
  return current;
}

function maxDate(left?: Date | null, right?: Date | null) {
  if (!left) return right ?? undefined;
  if (!right) return left;
  return left > right ? left : right;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
