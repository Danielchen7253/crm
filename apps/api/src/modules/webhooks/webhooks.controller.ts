import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import type { InboundAttachment, NormalizedInboundMessage } from "@coolfix-crm/shared";
import { IngestService } from "../inbox/ingest.service";

@Controller("webhooks")
export class WebhooksController {
  constructor(private readonly ingest: IngestService) {}

  @Get("meta")
  verifyMeta(@Query("hub.mode") mode?: string, @Query("hub.verify_token") token?: string, @Query("hub.challenge") challenge?: string) {
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

  @Post("twilio/status")
  twilioStatus(@Body() body: any) {
    return { ok: true, providerMessageId: body.MessageSid, status: body.MessageStatus, errorCode: body.ErrorCode };
  }

  @Post("meta")
  async ingestMeta(@Body() body: any) {
    const messages = this.normalizeMetaMessages(body);
    for (const message of messages) {
      await this.ingest.ingestInbound(message);
    }
    return { ok: true, count: messages.length };
  }

  @Post("whatsapp")
  async ingestWhatsApp(@Body() body: any) {
    const messages = this.normalizeMetaMessages(body).filter((message) => message.channel === "whatsapp");
    for (const message of messages) {
      await this.ingest.ingestInbound(message);
    }
    return { ok: true, channel: "whatsapp", count: messages.length };
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

  private normalizeMetaMessages(body: any): NormalizedInboundMessage[] {
    const entries = body.entry ?? [];
    const normalized: NormalizedInboundMessage[] = [];

    for (const entry of entries) {
      for (const event of entry.messaging ?? []) {
        if (!event.message) continue;
        normalized.push({
          channel: "messenger",
          provider: "meta",
          channelAccountExternalId: event.recipient?.id,
          externalThreadId: event.sender?.id,
          externalMessageId: event.message.mid,
          senderExternalId: event.sender?.id,
          text: event.message.text,
          timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : undefined,
          attachments: (event.message.attachments ?? []).map((attachment: any) => ({
            type: attachment.type === "image" ? "image" : attachment.type === "audio" ? "audio" : attachment.type === "video" ? "video" : "file",
            url: attachment.payload?.url,
          })),
          rawPayload: event,
        });
      }

      for (const change of entry.changes ?? []) {
        for (const waMessage of change.value?.messages ?? []) {
          normalized.push({
            channel: "whatsapp",
            provider: "meta",
            channelAccountExternalId: change.value?.metadata?.phone_number_id,
            externalThreadId: waMessage.from,
            externalMessageId: waMessage.id,
            senderExternalId: waMessage.from,
            senderName: change.value?.contacts?.[0]?.profile?.name,
            phone: waMessage.from,
            text: this.whatsAppText(waMessage),
            timestamp: waMessage.timestamp ? new Date(Number(waMessage.timestamp) * 1000).toISOString() : undefined,
            attachments: this.normalizeWhatsAppAttachments(waMessage),
            rawPayload: change,
          });
        }
      }
    }

    return normalized;
  }

  private normalizeWhatsAppAttachments(message: any) {
    const attachment = message.image ?? message.audio ?? message.video ?? message.document;
    if (!attachment) return [];
    return [
      {
        type: message.type === "document" ? "file" : message.type,
        url: attachment.link ?? attachment.id,
        mimeType: attachment.mime_type,
        fileName: attachment.filename,
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
}
