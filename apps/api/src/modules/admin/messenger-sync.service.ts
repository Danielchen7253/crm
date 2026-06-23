import { Injectable } from "@nestjs/common";
import { Channel } from "@prisma/client";
import type { InboundAttachment, NormalizedInboundMessage } from "@coolfix-crm/shared";
import { IngestService } from "../inbox/ingest.service";
import { PrismaService } from "../prisma/prisma.service";

type SyncStatus = {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  conversationsSeen: number;
  customersEnsured: number;
  messagesImported: number;
  messagesSkipped: number;
  errors: number;
  lastError?: string;
};

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

type GraphMessage = {
  id: string;
  created_time?: string;
  from?: { id?: string; name?: string; email?: string };
  message?: string;
  attachments?: { data?: GraphAttachment[] };
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

@Injectable()
export class MessengerSyncService {
  private status: SyncStatus = {
    running: false,
    conversationsSeen: 0,
    customersEnsured: 0,
    messagesImported: 0,
    messagesSkipped: 0,
    errors: 0,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: IngestService,
  ) {}

  getStatus() {
    return this.status;
  }

  start(options: { limit?: number; messagesPerConversation?: number } = {}) {
    if (this.status.running) return { started: false, status: this.status };
    this.status = {
      running: true,
      startedAt: new Date().toISOString(),
      conversationsSeen: 0,
      customersEnsured: 0,
      messagesImported: 0,
      messagesSkipped: 0,
      errors: 0,
    };
    void this.run(options).catch((error) => {
      this.status.running = false;
      this.status.finishedAt = new Date().toISOString();
      this.status.errors += 1;
      this.status.lastError = error instanceof Error ? error.message : String(error);
      console.error("Messenger sync failed", error);
    });
    return { started: true, status: this.status };
  }

  private async run(options: { limit?: number; messagesPerConversation?: number }) {
    const token = process.env.MESSENGER_PAGE_ACCESS_TOKEN ?? process.env.PAGE_ACCESS_TOKEN ?? process.env.META_PAGE_ACCESS_TOKEN;
    if (!token) throw new Error("Missing MESSENGER_PAGE_ACCESS_TOKEN");

    const pageId = process.env.MESSENGER_PAGE_ID ?? "1071930952666440";
    const graphVersion = process.env.META_GRAPH_VERSION ?? "v25.0";
    const limit = options.limit ?? Number(process.env.MESSENGER_SYNC_LIMIT ?? "5000");
    const messagesPerConversation = options.messagesPerConversation ?? Number(process.env.MESSENGER_SYNC_MESSAGES_PER_CONVERSATION ?? "50");

    const syncLog = await this.prisma.syncLog.create({
      data: {
        channel: Channel.messenger,
        syncType: "page_conversations_backfill",
        status: "running",
        metadata: { pageId, limit, messagesPerConversation },
      },
    });

    try {
      let url =
        `https://graph.facebook.com/${graphVersion}/${pageId}/conversations` +
        `?fields=id,updated_time,participants.limit(10){id,name,email}` +
        `&limit=100&access_token=${encodeURIComponent(token)}`;

      while (url && this.status.conversationsSeen < limit) {
        const page = await this.graph<GraphConversation>(url);
        for (const conversation of page.data ?? []) {
          if (this.status.conversationsSeen >= limit) break;
          this.status.conversationsSeen += 1;
          await this.importConversation(conversation, { pageId, graphVersion, token, messagesPerConversation }).catch((error) => {
            this.status.errors += 1;
            this.status.lastError = error instanceof Error ? error.message : String(error);
            console.error("Messenger conversation sync failed", conversation.id, error);
          });
        }
        url = page.paging?.next ?? "";
      }

      this.status.running = false;
      this.status.finishedAt = new Date().toISOString();
      await this.prisma.syncLog.update({
        where: { id: syncLog.id },
        data: {
          status: this.status.errors ? "completed_with_errors" : "completed",
          finishedAt: new Date(),
          importedMessagesCount: this.status.messagesImported,
          importedCustomersCount: this.status.customersEnsured,
          metadata: { ...this.status, pageId, limit, messagesPerConversation },
        },
      });
    } catch (error) {
      this.status.running = false;
      this.status.finishedAt = new Date().toISOString();
      await this.prisma.syncLog.update({
        where: { id: syncLog.id },
        data: {
          status: "failed",
          finishedAt: new Date(),
          errorMessage: error instanceof Error ? error.message : String(error),
          metadata: { ...this.status },
        },
      });
      throw error;
    }
  }

  private async importConversation(
    conversation: GraphConversation,
    config: { pageId: string; graphVersion: string; token: string; messagesPerConversation: number },
  ) {
    const customerParticipant = (conversation.participants?.data ?? []).find((participant) => participant.id !== config.pageId);
    if (!customerParticipant?.id) return;

    await this.ensureCustomerConversation(conversation, customerParticipant, config);

    let imported = 0;
    let url =
      `https://graph.facebook.com/${config.graphVersion}/${conversation.id}/messages` +
      `?fields=id,created_time,from,message,attachments.limit(10){id,name,size,mime_type,file_url,image_data,video_data}` +
      `&limit=25&access_token=${encodeURIComponent(config.token)}`;

    while (url && imported < config.messagesPerConversation) {
      const page = await this.graph<GraphMessage>(url);
      for (const message of page.data ?? []) {
        if (imported >= config.messagesPerConversation) break;
        imported += 1;
        if (message.from?.id !== customerParticipant.id) {
          this.status.messagesSkipped += 1;
          continue;
        }
        const existing = await this.prisma.message.findUnique({
          where: { channel_externalMessageId: { channel: Channel.messenger, externalMessageId: message.id } },
        });
        if (existing) {
          this.status.messagesSkipped += 1;
          continue;
        }
        const result = await this.ingest.ingestInbound(this.toInbound(message, conversation.id, customerParticipant, config));
        if (result.duplicate) this.status.messagesSkipped += 1;
        else this.status.messagesImported += 1;
      }
      url = page.paging?.next ?? "";
    }
  }

  private async ensureCustomerConversation(
    conversation: GraphConversation,
    participant: { id: string; name?: string; email?: string },
    config: { pageId: string; graphVersion: string; token: string },
  ) {
    const profile = await this.fetchProfile(participant.id, config).catch(() => undefined);
    const displayName = profile?.name ?? participant.name ?? "Facebook customer";
    const avatarUrl = profile?.profile_pic;
    const lastMessageAt = conversation.updated_time ? new Date(conversation.updated_time) : new Date();

    let identity = await this.prisma.customerIdentity.findUnique({
      where: { provider_externalId: { provider: "messenger", externalId: participant.id } },
      include: { customer: true },
    });

    if (!identity) {
      const customer = await this.prisma.customer.create({
        data: {
          displayName,
          primaryEmail: participant.email?.toLowerCase(),
          source: Channel.messenger,
          avatarUrl,
          lastMessageAt,
          lastContactAt: lastMessageAt,
          metadata: { messenger_psid: participant.id },
        },
      });
      identity = await this.prisma.customerIdentity.create({
        data: {
          customerId: customer.id,
          channel: Channel.messenger,
          provider: "messenger",
          externalId: participant.id,
          externalUserId: participant.id,
          email: participant.email?.toLowerCase(),
          displayName,
          avatarUrl,
          rawProfile: profile ?? participant,
          lastSeenAt: lastMessageAt,
        },
        include: { customer: true },
      });
    } else {
      await this.prisma.customer.update({
        where: { id: identity.customerId },
        data: {
          displayName: this.betterName(identity.customer.displayName, displayName),
          avatarUrl: identity.customer.avatarUrl ?? avatarUrl,
          lastMessageAt: this.maxDate(identity.customer.lastMessageAt, lastMessageAt),
          lastContactAt: this.maxDate(identity.customer.lastContactAt, lastMessageAt),
        },
      });
      await this.prisma.customerIdentity.update({
        where: { id: identity.id },
        data: {
          displayName: identity.displayName ?? displayName,
          avatarUrl: identity.avatarUrl ?? avatarUrl,
          rawProfile: profile ?? participant,
          lastSeenAt: lastMessageAt,
        },
      });
    }

    await this.prisma.conversation.upsert({
      where: { channel_externalThreadId: { channel: Channel.messenger, externalThreadId: conversation.id } },
      update: {
        customerId: identity.customerId,
        identityId: identity.id,
        lastMessageAt,
      },
      create: {
        customerId: identity.customerId,
        identityId: identity.id,
        channel: Channel.messenger,
        externalThreadId: conversation.id,
        status: "open",
        lastMessageAt,
        metadata: { pageId: config.pageId },
      },
    });

    this.status.customersEnsured += 1;
  }

  private toInbound(
    message: GraphMessage,
    conversationId: string,
    participant: { id: string; name?: string; email?: string },
    config: { graphVersion: string; token: string },
  ): NormalizedInboundMessage {
    const attachments = this.normalizeAttachments(message.attachments?.data ?? []);
    const text = message.message ?? (attachments.length ? `[Messenger ${attachments[0].type}]` : "");
    return {
      channel: "messenger",
      provider: "messenger",
      channelAccountExternalId: config.graphVersion,
      externalThreadId: conversationId,
      externalMessageId: message.id,
      senderExternalId: participant.id,
      senderName: message.from?.name ?? participant.name,
      email: participant.email,
      text,
      timestamp: message.created_time,
      attachments,
      rawPayload: message,
    };
  }

  private normalizeAttachments(items: GraphAttachment[]): InboundAttachment[] {
    return items
      .map((item): InboundAttachment | null => {
        const url = item.image_data?.url ?? item.video_data?.url ?? item.file_url;
        if (!url) return null;
        return {
          type: this.mediaType(item.mime_type, url),
          url,
          mimeType: item.mime_type,
          fileName: item.name,
          sizeBytes: item.size,
          externalMediaId: item.id,
        };
      })
      .filter((item): item is InboundAttachment => Boolean(item));
  }

  private mediaType(mimeType?: string, url?: string): InboundAttachment["type"] {
    const probe = `${mimeType ?? ""} ${url ?? ""}`.toLowerCase();
    if (probe.includes("image") || /\.(png|jpe?g|gif|webp|heic)([?#/]|$)/.test(probe)) return "image";
    if (probe.includes("audio") || /\.(mp3|m4a|wav|ogg|opus|aac)([?#/]|$)/.test(probe)) return "audio";
    if (probe.includes("video") || /\.(mp4|mov|webm|avi)([?#/]|$)/.test(probe)) return "video";
    return "file";
  }

  private async fetchProfile(psid: string, config: { graphVersion: string; token: string }) {
    const url =
      `https://graph.facebook.com/${config.graphVersion}/${psid}` +
      `?fields=first_name,last_name,name,profile_pic&access_token=${encodeURIComponent(config.token)}`;
    const raw = await fetch(url).then((response) => response.json());
    if (raw.error) return undefined;
    return { name: raw.name ?? [raw.first_name, raw.last_name].filter(Boolean).join(" "), profile_pic: raw.profile_pic };
  }

  private async graph<T>(url: string): Promise<GraphPage<T>> {
    const response = await fetch(url);
    const json = (await response.json()) as GraphPage<T>;
    if (!response.ok || json.error) throw new Error(json.error?.message ?? response.statusText);
    return json;
  }

  private betterName(current?: string | null, incoming?: string) {
    if (!incoming) return current ?? undefined;
    if (!current || current === "New customer" || current === "Facebook customer" || current === "Facebook 用户") return incoming;
    return current;
  }

  private maxDate(left?: Date | null, right?: Date | null) {
    if (!left) return right ?? undefined;
    if (!right) return left;
    return left > right ? left : right;
  }
}
