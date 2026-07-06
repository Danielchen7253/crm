import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Channel, MessageDirection, MessageStatus, MessageType } from "@prisma/client";
import type { InboundAttachment, NormalizedInboundMessage } from "@coolfix-crm/shared";
import { AiService } from "../ai/ai.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { TagsService } from "../tags/tags.service";

@Injectable()
export class IngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly ai: AiService,
    private readonly tags: TagsService,
  ) {}

  async ingestInbound(input: NormalizedInboundMessage) {
    const channel = input.channel as Channel;
    const sentAt = input.timestamp ? new Date(input.timestamp) : new Date();

    const webhookEvent = await this.prisma.webhookEvent.create({
      data: {
        channel,
        provider: input.provider,
        eventType: "message",
        externalEventId: input.externalMessageId,
        signatureValid: true,
        status: "received",
        rawPayload: input.rawPayload as object,
      },
    });

    const dedupeKey = this.buildDedupeKey(input, sentAt);
    const existing = await this.findExistingMessage(channel, input.externalMessageId, dedupeKey);
    if (existing) {
      await this.prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processed: true, processedAt: new Date() },
      });
      return { message: existing, duplicate: true };
    }

    const customer = await this.findOrCreateCustomer(input);
    const identity = await this.findOrCreateIdentity(customer.id, input);
    const conversation = await this.findOrCreateConversation(customer.id, identity.id, channel, input);

    const type = this.detectMessageType(input);
    const message = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        customerId: customer.id,
        channelAccountId: conversation.channelAccountId,
        channel,
        provider: input.provider,
        externalMessageId: input.externalMessageId,
        externalConversationId: input.externalThreadId,
        fallbackDedupeKey: input.externalMessageId ? undefined : dedupeKey,
        senderExternalId: input.senderExternalId,
        senderType: "customer",
        direction: MessageDirection.inbound,
        type,
        contentType: type,
        status: MessageStatus.received,
        text: input.text,
        textContent: input.text,
        contentHash: this.hash(input.text ?? JSON.stringify(input.attachments ?? [])),
        rawEvent: input.rawPayload as object,
        sentAt,
        attachments: {
          create: (input.attachments ?? []).map((attachment: InboundAttachment) => ({
            type: attachment.type as MessageType,
            url: attachment.url,
            fileUrl: attachment.url,
            mimeType: attachment.mimeType,
            fileName: attachment.fileName,
            sizeBytes: attachment.sizeBytes,
            externalMediaId: attachment.externalMediaId,
          })),
        },
      },
      include: { attachments: true },
    });

    await this.prisma.$transaction([
      this.prisma.customer.update({
        where: { id: customer.id },
        data: {
          displayName: this.mergedDisplayName(customer.displayName, input.senderName, input.phone, input.email),
          avatarUrl: customer.avatarUrl ?? input.senderAvatarUrl,
          primaryPhone: customer.primaryPhone ?? input.phone,
          primaryEmail: customer.primaryEmail ?? input.email,
          lastMessageAt: sentAt,
          lastContactAt: sentAt,
        },
      }),
      this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: sentAt,
          unreadCount: { increment: 1 },
          status: conversation.status === "closed" ? "open" : conversation.status,
        },
      }),
      this.prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processed: true, processedAt: new Date() },
      }),
    ]);

    void this.tags
      .applyAutomaticTags({
        customerId: customer.id,
        channel,
        text: input.text,
      })
      .catch((error) => {
        console.error("Automatic tagging failed", error);
      });

    this.realtime.emitInboxEvent("message.created", {
      customerId: customer.id,
      conversationId: conversation.id,
      message,
    });

    void this.ai.createSuggestionForMessage(message.id).catch((error) => {
      console.error("AI suggestion failed", error);
    });
    return { message, duplicate: false };
  }

  private async findExistingMessage(channel: Channel, externalMessageId?: string, fallbackDedupeKey?: string) {
    if (externalMessageId) {
      const byExternalId = await this.prisma.message.findUnique({
        where: { channel_externalMessageId: { channel, externalMessageId } },
      });
      if (byExternalId) return byExternalId;
    }

    if (fallbackDedupeKey) {
      return this.prisma.message.findUnique({ where: { fallbackDedupeKey } });
    }

    return null;
  }

  private async findOrCreateCustomer(input: NormalizedInboundMessage) {
    const phone = this.normalizePhone(input.phone);
    const email = input.email?.trim().toLowerCase();

    if (phone) {
      const byPhone = await this.prisma.customer.findFirst({ where: { primaryPhone: phone, deletedAt: null } });
      if (byPhone) return byPhone;
    }

    if (email) {
      const byEmail = await this.prisma.customer.findFirst({ where: { primaryEmail: email, deletedAt: null } });
      if (byEmail) return byEmail;
    }

    if (phone || email) {
      const identity = await this.prisma.customerIdentity.findFirst({
        where: { OR: [{ phone }, { email }] },
        include: { customer: true },
      });
      if (identity?.customer && !identity.customer.deletedAt) return identity.customer;
    }

    return this.prisma.customer.create({
      data: {
        displayName: input.senderName ?? phone ?? email ?? "New customer",
        primaryPhone: phone,
        primaryEmail: email,
        source: input.channel as Channel,
        avatarUrl: input.senderAvatarUrl,
        lastMessageAt: input.timestamp ? new Date(input.timestamp) : new Date(),
      },
    });
  }

  private async findOrCreateIdentity(customerId: string, input: NormalizedInboundMessage) {
    const provider = input.provider;
    const externalId = input.senderExternalId;

    return this.prisma.customerIdentity.upsert({
      where: { provider_externalId: { provider, externalId } },
      update: {
        customerId,
        phone: this.normalizePhone(input.phone),
        email: input.email?.trim().toLowerCase(),
        displayName: input.senderName,
        avatarUrl: input.senderAvatarUrl,
        rawProfile: input.rawPayload as object,
        externalUserId: externalId,
        lastSeenAt: input.timestamp ? new Date(input.timestamp) : new Date(),
      },
      create: {
        customerId,
        channel: input.channel as Channel,
        provider,
        externalId,
        externalUserId: externalId,
        phone: this.normalizePhone(input.phone),
        email: input.email?.trim().toLowerCase(),
        displayName: input.senderName,
        avatarUrl: input.senderAvatarUrl,
        rawProfile: input.rawPayload as object,
        lastSeenAt: input.timestamp ? new Date(input.timestamp) : new Date(),
      },
    });
  }

  private async findOrCreateConversation(
    customerId: string,
    identityId: string,
    channel: Channel,
    input: NormalizedInboundMessage,
  ) {
    const externalThreadId = input.externalThreadId ?? `${input.provider}:${input.senderExternalId}`;
    const channelAccountId = await this.resolveChannelAccountId(channel, input.channelAccountExternalId);
    return this.prisma.conversation.upsert({
      where: { channel_externalThreadId: { channel, externalThreadId } },
      update: { customerId, identityId, ...(channelAccountId ? { channelAccountId } : {}) },
      create: {
        customerId,
        identityId,
        channel,
        externalThreadId,
        ...(channelAccountId ? { channelAccountId } : {}),
        status: "open",
        lastMessageAt: input.timestamp ? new Date(input.timestamp) : new Date(),
      },
    });
  }

  private async resolveChannelAccountId(channel: Channel, channelAccountExternalId?: string | null): Promise<string | null> {
    const pickFallback = async () =>
      this.pickBestChannelAccount(
        await this.prisma.channelAccount.findMany({
          where: { channel, isActive: true },
          orderBy: { createdAt: "asc" },
        }),
      )?.id ?? null;

    const normalizedExternalId = channelAccountExternalId?.trim?.();
    if (!normalizedExternalId) return pickFallback();

    const matched = await this.prisma.channelAccount.findMany({
      where: {
        channel,
        isActive: true,
        OR: [{ providerAccountId: normalizedExternalId }, { externalPageId: normalizedExternalId }],
      },
      orderBy: { createdAt: "asc" },
    });
    if (matched.length) {
      const picked = this.pickBestChannelAccount(matched);
      return picked?.id ?? null;
    }

    return this.pickFallbackWithPriority(channel);
  }

  private async pickFallbackWithPriority(channel: Channel): Promise<string | null> {
    const accounts = await this.prisma.channelAccount.findMany({
      where: { channel, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    return this.pickBestChannelAccount(accounts)?.id ?? null;
  }

  private pickBestChannelAccount(accounts: Array<{
    id: string;
    name?: string | null;
    encryptedSecret?: string | null;
    encryptedToken?: string | null;
    fromAddress?: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>): { id: string; name?: string | null; encryptedSecret?: string | null; encryptedToken?: string | null; fromAddress?: string | null; createdAt: Date; updatedAt: Date; } | null {
    if (!accounts.length) return null;

    const score = (account: typeof accounts[number]) => {
      let value = 0;
      const name = (account.name ?? "").toLowerCase();
      if (name.startsWith("auto_")) value += 16;
      if (name.includes("twilio") || name.includes("whatsapp") || name.includes("messenger") || name.includes("instagram") || name.includes("email") || name.includes("website")) {
        value += 4;
      }
      if (account.encryptedSecret?.trim()) value += 8;
      if (account.encryptedToken?.trim()) value += 4;
      if (account.fromAddress?.trim()) value += 2;
      return value;
    };

    return [...accounts].sort((left, right) => {
      const diff = score(right) - score(left);
      if (diff !== 0) return diff;
      return right.updatedAt.getTime() - left.updatedAt.getTime();
    })[0] ?? null;
  }

  private buildDedupeKey(input: NormalizedInboundMessage, sentAt: Date) {
    return [
      input.channel,
      input.provider,
      input.senderExternalId,
      sentAt.toISOString(),
      this.hash(input.text ?? JSON.stringify(input.attachments ?? [])),
    ].join(":");
  }

  private detectMessageType(input: NormalizedInboundMessage) {
    return (input.attachments?.[0]?.type as MessageType | undefined) ?? MessageType.text;
  }

  private hash(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }

  private normalizePhone(phone?: string) {
    if (!phone) return undefined;
    const digits = phone.replace(/\D/g, "");
    if (!digits) return undefined;
    return digits.length === 10 ? `1${digits}` : digits;
  }

  private mergedDisplayName(current?: string | null, incoming?: string, phone?: string, email?: string) {
    if (!incoming?.trim()) return current ?? undefined;
    if (!current?.trim()) return incoming.trim();

    const normalizedCurrent = current.trim().toLowerCase();
    const normalizedPhone = this.normalizePhone(phone);
    const normalizedEmail = email?.trim().toLowerCase();
    const placeholders = [
      "new customer",
      "facebook 用户",
      normalizedPhone,
      normalizedEmail,
      normalizedPhone ? `sms +${normalizedPhone}` : undefined,
      normalizedPhone ? `phone +${normalizedPhone}` : undefined,
      normalizedPhone ? `whatsapp +${normalizedPhone}` : undefined,
    ].filter(Boolean);

    if (placeholders.includes(normalizedCurrent)) return incoming.trim();
    return current;
  }
}
