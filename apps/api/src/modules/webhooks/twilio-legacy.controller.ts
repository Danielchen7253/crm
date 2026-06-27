import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { MessageStatus } from "@prisma/client";
import type { InboundAttachment } from "@coolfix-crm/shared";
import { IngestService } from "../inbox/ingest.service";
import { CallsService } from "../calls/calls.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

@Controller()
export class TwilioLegacyController {
  constructor(
    private readonly ingest: IngestService,
    private readonly calls: CallsService,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  @Post("twilio/incoming")
  @HttpCode(HttpStatus.OK)
  ingestTwilioIncomingLegacy(@Body() body: any) {
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

  @Post("webhooks/twilio/incoming")
  @HttpCode(HttpStatus.OK)
  ingestTwilioIncomingLegacyAlias(@Body() body: any) {
    return this.ingestTwilioIncomingLegacy(body);
  }

  @Post("webhooks/twilio/sms")
  @HttpCode(HttpStatus.OK)
  ingestTwilioSmsAlias(@Body() body: any) {
    return this.ingestTwilioIncomingLegacy(body);
  }

  @Post("twilio/status")
  @HttpCode(HttpStatus.OK)
  async twilioStatusLegacy(@Body() body: any) {
    const callSid = this.firstDefined(body?.CallSid, body?.callSid, body?.call_sid);
    if (callSid) {
      const callUpdate = await this.calls.updateFromTwilioStatus({
        callSid,
        status: body.CallStatus ?? body.callStatus ?? body.status,
        duration: body.CallDuration ?? body.duration,
        rawPayload: body,
      });
      if (callUpdate.matched) return callUpdate;
    }

    const providerMessageId =
      this.firstDefined(body?.MessageSid, body?.SmsSid, body?.messageSid, body?.Sid, body?.MessageStatus?.messageSid) ?? undefined;
    const status = this.mapProviderStatus(this.firstDefined(body?.MessageStatus, body?.messageStatus, body?.status));
    if (!providerMessageId) return { ok: true, matched: false, providerMessageId: undefined };

    const message = await this.prisma.message.findFirst({ where: { externalMessageId: providerMessageId ?? undefined } });
    if (!message) return { ok: true, matched: false, providerMessageId };

    const statusTimestamp = this.parseTimestamp(
      this.firstDefined(body?.Timestamp, body?.timestamp, body?.DateUpdated, body?.DateCreated, body?.date_created, body?.date_updated),
    );
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

  @Post("webhooks/twilio/status")
  @HttpCode(HttpStatus.OK)
  async twilioStatusWebhookAlias(@Body() body: any) {
    return this.twilioStatusLegacy(body);
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
