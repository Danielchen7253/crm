import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Channel, MessageDirection, MessageStatus, MessageType } from "@prisma/client";
import type { InboundAttachment, NormalizedInboundMessage } from "@coolfix-crm/shared";
import { AiService } from "../ai/ai.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

@Injectable()
export class IngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly ai: AiService,
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
    return this.prisma.conversation.upsert({
      where: { channel_externalThreadId: { channel, externalThreadId } },
      update: { customerId, identityId },
      create: {
        customerId,
        identityId,
        channel,
        externalThreadId,
        status: "open",
        lastMessageAt: input.timestamp ? new Date(input.timestamp) : new Date(),
      },
    });
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
