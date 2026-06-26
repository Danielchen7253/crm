import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { MessageStatus } from "@prisma/client";
import type { InboundAttachment, NormalizedInboundMessage } from "@coolfix-crm/shared";
import { IngestService } from "../inbox/ingest.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

@Controller("webhooks")
export class WebhooksController {
  constructor(
    private readonly ingest: IngestService,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  @Get("meta")
  verifyMeta(@Query("hub.mode") mode?: string, @Query("hub.verify_token") token?: string, @Query("hub.challenge") challenge?: string) {
    if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) return challenge;
    return "invalid";
  }

  @Get("messenger")
  verifyMessenger(
    @Query("hub.mode") mode?: string,
    @Query("hub.verify_token") token?: string,
    @Query("hub.challenge") challenge?: string,
  ) {
    if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) return challenge;
    return "invalid";
  }

  @Get("whatsapp")
  verifyWhatsApp(
    @Query("hub.mode") mode?: string,
    @Query("hub.verify_token") token?: string,
    @Query("hub.challenge") challenge?: string,
  ) {
    if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) return challenge;
    return "invalid";
  }

  @Get("instagram")
  verifyInstagram(
    @Query("hub.mode") mode?: string,
    @Query("hub.verify_token") token?: string,
    @Query("hub.challenge") challenge?: string,
  ) {
    if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) return challenge;
    return "invalid";
  }

  @Get("website-chat")
  verifyWebsiteChat() {
    return "invalid";
  }

  @Get("website_chat")
  verifyWebsiteChatLegacy() {
    return "invalid";
  }

  @Get("whatsapp/health")
  async whatsappHealth() {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_ACCESS_TOKEN ?? process.env.META_ACCESS_TOKEN;
    const result: Record<string, unknown> = {
      webhookUrl: "/api/webhooks/whatsapp",
      verifyTokenConfigured: Boolean(process.env.META_VERIFY_TOKEN),
      phoneNumberIdConfigured: Boolean(phoneNumberId),
      accessTokenConfigured: Boolean(token),
      graphOk: false,
    };

    if (!phoneNumberId || !token) return result;

    const url = new URL(`https://graph.facebook.com/v25.0/${phoneNumberId}`);
    url.searchParams.set("fields", "id,display_phone_number,verified_name,quality_rating,platform_type,code_verification_status");
    url.searchParams.set("access_token", token);

    const response = await fetch(url);
    const raw = await response.json().catch(() => ({}));
    result.graphOk = response.ok;
    result.phoneNumber = response.ok ? raw : undefined;
    result.error = response.ok ? undefined : raw?.error?.message ?? response.statusText;
    result.errorCode = response.ok ? undefined : raw?.error?.code;
    result.errorSubcode = response.ok ? undefined : raw?.error?.error_subcode;
    return result;
  }

  @Post("website-chat")
  ingestWebsiteChat(@Body() body: any) {
    return this.ingest.ingestInbound({
      channel: "website_chat",
      provider: "coolfix-widget",
      externalThreadId: body.sessionId,
      externalMessageId: body.messageId,
      senderExternalId: body.visitorId ?? body.sessionId,
      senderName: body.name,
      phone: body.phone,
      email: body.email,
      text: body.text,
      timestamp: body.timestamp,
      attachments: body.attachments,
      rawPayload: body,
    });
  }

  @Post("website_chat")
  ingestWebsiteChatLegacy(@Body() body: any) {
    return this.ingestWebsiteChat(body);
  }

  @Post("website-chat")
  ingestWebsiteChatLegacyDash(@Body() body: any) {
    return this.ingestWebsiteChat(body);
  }

  @Post("twilio/sms")
  ingestTwilioSms(@Body() body: any) {
    return this.ingest.ingestInbound({
      channel: "sms",
      provider: "twilio",
      channelAccountExternalId: body.To,
      externalThreadId: body.From,
      externalMessageId: body.MessageSid ?? body.SmsSid,
      senderExternalId: body.From,
      phone: body.From,
      text: body.Body,
      timestamp: new Date().toISOString(),
      attachments: this.twilioAttachments(body),
      rawPayload: body,
    });
  }

  @Post("twilio/incoming")
  ingestTwilioIncomingLegacy(@Body() body: any) {
    return this.ingestTwilioSms(body);
  }

  @Post("twilio/status")
  async twilioStatus(@Body() body: any) {
    const providerMessageId =
      this.firstDefined(body?.MessageSid, body?.SmsSid, body?.messageSid, body?.Sid, body?.MessageStatus?.messageSid) ??
      undefined;
    const status = this.mapProviderStatus(this.firstDefined(body?.MessageStatus, body?.messageStatus, body?.status));
    if (!providerMessageId) return { ok: true, matched: false, providerMessageId: undefined };
    const message = await this.prisma.message.findFirst({
      where: { externalMessageId: providerMessageId ?? undefined },
    });

    if (!message) return { ok: true, matched: false, providerMessageId };

    const statusTimestamp =
      this.parseTimestamp(this.firstDefined(body?.Timestamp, body?.timestamp, body?.DateUpdated, body?.DateCreated, body?.date_created, body?.date_updated));
    const providerErrorMessage = body.ErrorMessage ?? body.ErrorText ?? body.error_message;
    const providerErrorCode = this.firstDefined(
      body.ErrorCode,
      body.ErrorCodeSid,
      body.error_code,
      body.errorMessage?.code,
    );

    const updated = await this.prisma.message.update({
      where: { id: message.id },
      data: {
        status,
        providerErrorCode: providerErrorCode ? String(providerErrorCode) : undefined,
        providerErrorMessage,
        failedReason: providerErrorMessage ?? (status === MessageStatus.failed ? String(status) : undefined),
        deliveredAt: status === MessageStatus.delivered ? statusTimestamp : undefined,
        readAt: status === MessageStatus.read ? statusTimestamp : undefined,
        rawEvent: body,
      },
      include: { attachments: true, aiReplyLogs: true },
    });

    this.realtime.emitInboxEvent("message.status", {
      conversationId: updated.conversationId,
      customerId: updated.customerId,
      message: updated,
    });

    return { ok: true, matched: true, providerMessageId, status };
  }

  @Post("meta")
  async ingestMeta(@Body() body: any) {
    const messages = await this.normalizeMetaMessages(body);
    for (const message of messages) {
      await this.ingest.ingestInbound(message);
    }
    return { ok: true, count: messages.length };
  }

  @Post("whatsapp")
  async ingestWhatsApp(@Body() body: any) {
    await this.processMetaStatuses(body);
    const messages = (await this.normalizeMetaMessages(body)).filter((message) => message.channel === "whatsapp");
    for (const message of messages) {
      await this.ingest.ingestInbound(message);
    }
    return { ok: true, channel: "whatsapp", count: messages.length };
  }

  @Post("messenger")
  async ingestMessenger(@Body() body: any) {
    return this.ingestMeta(body);
  }

  @Post("instagram")
  async ingestInstagram(@Body() body: any) {
    const messages = (await this.normalizeMetaMessages(body)).filter((message) => message.channel === "instagram");
    for (const message of messages) {
      await this.ingest.ingestInbound(message);
    }
    return { ok: true, channel: "instagram", count: messages.length };
  }

  @Post("email")
  ingestEmail(@Body() body: any) {
    return this.ingest.ingestInbound({
      channel: "email",
      provider: body.provider ?? "smtp",
      externalThreadId: body.threadId ?? body.from,
      externalMessageId: body.messageId,
      senderExternalId: body.from,
      senderName: body.fromName,
      email: body.from,
      text: body.text,
      timestamp: body.date,
      attachments: body.attachments,
      rawPayload: body,
    });
  }

  private twilioAttachments(body: any): InboundAttachment[] {
    const count = Number(body.NumMedia ?? 0);
    return Array.from({ length: count }, (_, index) => ({
      type: this.mediaType(body[`MediaContentType${index}`]),
      url: body[`MediaUrl${index}`],
      mimeType: body[`MediaContentType${index}`],
    })).filter((item) => item.url);
  }

  private mediaType(mime?: string): InboundAttachment["type"] {
    if (mime?.startsWith("image/")) return "image";
    if (mime?.startsWith("audio/")) return "audio";
    if (mime?.startsWith("video/")) return "video";
    return "file";
  }

  private async normalizeMetaMessages(body: any): Promise<NormalizedInboundMessage[]> {
    const entries = body.entry ?? [];
    const normalized: NormalizedInboundMessage[] = [];

    for (const entry of entries) {
      for (const event of entry.messaging ?? []) {
        if (!event.message) continue;
        if (event.message.is_echo) continue;
        const channel: NormalizedInboundMessage["channel"] = body.object === "instagram" ? "instagram" : "messenger";
        const senderId = event.sender?.id;
        if (!senderId) continue;
        const profile = await this.fetchMetaProfile(channel, senderId);
        const provider = channel === "instagram" ? "instagram" : "messenger";
        normalized.push({
          channel,
          provider,
          channelAccountExternalId: event.recipient?.id,
          externalThreadId: senderId,
          externalMessageId: event.message.mid,
          senderExternalId: senderId,
          senderName: profile?.name,
          senderAvatarUrl: profile?.avatarUrl,
          text: event.message.text,
          timestamp: this.parseTimestamp(event.timestamp)?.toISOString(),
          attachments: (event.message.attachments ?? []).map((attachment: any) => ({
            type: attachment.type === "image" ? "image" : attachment.type === "audio" ? "audio" : attachment.type === "video" ? "video" : "file",
            url: attachment.payload?.url,
            externalMediaId: attachment.payload?.id,
          })),
          rawPayload: { ...event, crmResolvedProfile: profile },
        });
      }

      for (const change of entry.changes ?? []) {
        for (const waMessage of change.value?.messages ?? []) {
          const contact = this.whatsAppContact(change.value?.contacts, waMessage.from);
          normalized.push({
            channel: "whatsapp",
            provider: "meta",
            channelAccountExternalId: change.value?.metadata?.phone_number_id,
            externalThreadId: waMessage.from,
            externalMessageId: waMessage.id,
          senderExternalId: waMessage.from,
          senderName: contact?.profile?.name,
          phone: waMessage.from,
          text: this.whatsAppText(waMessage),
          timestamp: this.parseTimestamp(waMessage.timestamp)?.toISOString(),
          attachments: this.normalizeWhatsAppAttachments(waMessage),
          rawPayload: change,
        });
      }
    }
    }

    return normalized;
  }

  private async fetchMetaProfile(channel: NormalizedInboundMessage["channel"], senderId: string) {
    if (channel !== "messenger" && channel !== "instagram") return undefined;
    const token =
      channel === "instagram"
        ? process.env.INSTAGRAM_ACCESS_TOKEN ?? process.env.META_ACCESS_TOKEN
        : process.env.MESSENGER_PAGE_ACCESS_TOKEN ?? process.env.PAGE_ACCESS_TOKEN ?? process.env.META_PAGE_ACCESS_TOKEN;
    if (!token) return undefined;

    const graphVersion = process.env.META_GRAPH_VERSION ?? "v25.0";
    const fields = channel === "instagram" ? "name,username,profile_pic" : "first_name,last_name,name,profile_pic";
    const url = `https://graph.facebook.com/${graphVersion}/${senderId}?fields=${fields}&access_token=${encodeURIComponent(token)}`;
    try {
      const response = await fetch(url);
      const raw = await response.json().catch(() => ({}));
      if (!response.ok || raw.error) return undefined;
      const name = raw.name ?? raw.username ?? [raw.first_name, raw.last_name].filter(Boolean).join(" ");
      return {
        name: name || undefined,
        avatarUrl: raw.profile_pic,
      };
    } catch {
      return undefined;
    }
  }

  private whatsAppContact(contacts: any[] | undefined, from?: string) {
    if (!contacts?.length) return undefined;
    return contacts.find((contact) => contact.wa_id === from) ?? contacts[0];
  }

  private normalizeWhatsAppAttachments(message: any) {
    const attachment = message.image ?? message.audio ?? message.video ?? message.document;
    if (!attachment) return [];
    return [
      {
        type: message.type === "document" ? "file" : message.type,
        url: attachment.link ?? `whatsapp-media:${attachment.id}`,
        mimeType: attachment.mime_type,
        fileName: attachment.filename,
        externalMediaId: attachment.id,
      },
    ];
  }

  private whatsAppText(message: any) {
    if (message.text?.body) return message.text.body;
    if (message.image?.caption) return message.image.caption;
    if (message.video?.caption) return message.video.caption;
    if (message.document?.caption) return message.document.caption;
    if (message.type === "audio") return "[WhatsApp voice message]";
    if (message.type === "image") return "[WhatsApp image]";
    if (message.type === "video") return "[WhatsApp video]";
    if (message.type === "document") return message.document?.filename ? `[WhatsApp file] ${message.document.filename}` : "[WhatsApp file]";
    return `[WhatsApp ${message.type ?? "message"}]`;
  }

  private async processMetaStatuses(body: any) {
    const entries = body.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        for (const item of change.value?.statuses ?? []) {
          const statusMessageId = this.firstDefined(item.id, item.message_id, item.wamid, item.message_sid, item.messageId);
          if (!statusMessageId) continue;
          const message = await this.prisma.message.findFirst({ where: { externalMessageId: statusMessageId } });
          if (!message) continue;

          const status = this.mapProviderStatus(item.status);
          const updated = await this.prisma.message.update({
            where: { id: message.id },
            data: {
              status,
              providerErrorCode: item.errors?.[0]?.code ? String(item.errors[0].code) : undefined,
              providerErrorMessage: item.errors?.[0]?.message,
              failedReason: item.errors?.[0]?.message,
              deliveredAt: status === MessageStatus.delivered ? this.parseTimestamp(item.timestamp) : undefined,
              readAt: status === MessageStatus.read ? this.parseTimestamp(item.timestamp) : undefined,
              rawEvent: change,
            },
            include: { attachments: true, aiReplyLogs: true },
          });
          this.realtime.emitInboxEvent("message.status", {
            conversationId: updated.conversationId,
            customerId: updated.customerId,
            message: updated,
          });
        }
      }
    }
  }

  private mapProviderStatus(value?: string): MessageStatus {
    if (value === "read") return MessageStatus.read;
    if (value === "delivered") return MessageStatus.delivered;
    if (value === "sent" || value === "accepted") return MessageStatus.sent;
    if (value === "received") return MessageStatus.received;
    if (value === "failed" || value === "undelivered") return MessageStatus.failed;
    if (value === "queued" || value === "sending") return MessageStatus.queued;
    if (value === "rejected" || value === "canceled" || value === "cancelled") return MessageStatus.failed;
    return MessageStatus.sent;
  }

  private firstDefined<T>(...values: Array<T | undefined | null>) {
    return values.find((value) => value !== undefined && value !== null && value !== "") as T | undefined;
  }

  private parseTimestamp(value?: string | number) {
    if (!value && value !== 0) return undefined;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return undefined;
    const isSeconds = numeric < 1_000_000_000_000;
    return new Date(isSeconds ? numeric * 1000 : numeric);
  }
}
