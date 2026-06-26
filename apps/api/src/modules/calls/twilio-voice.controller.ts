import { Body, Controller, Header, Post } from "@nestjs/common";
import { CallsService } from "./calls.service";
import { IngestService } from "../inbox/ingest.service";

@Controller("twilio")
export class TwilioVoiceController {
  constructor(
    private readonly calls: CallsService,
    private readonly ingest: IngestService,
  ) {}

  @Post("incoming")
  @Header("Content-Type", "text/xml")
  async incoming(@Body() body: any) {
    if (this.isSmsIncoming(body)) {
      const sent = await this.ingest.ingestInbound({
        channel: "sms",
        provider: "twilio",
        channelAccountExternalId: body.To,
        externalThreadId: body.From,
        externalMessageId: body.MessageSid ?? body.SmsSid,
        senderExternalId: body.From,
        phone: body.From,
        text: body.Body,
        timestamp: body.Timestamp ?? body.date_created ?? new Date().toISOString(),
        attachments: [],
        rawPayload: body,
      });
      return { ok: true, channel: "sms", inbound: sent.message?.id || null };
    }

    const call = await this.calls.startInboundCall({
      fromPhone: body.From ?? "",
      toPhone: body.To ?? "",
      twilioCallSid: body.CallSid,
    });
    const publicUrl = process.env.API_PUBLIC_URL ?? "https://example.com";
    const streamUrl = publicUrl.replace(/^http/, "ws") + `/api/realtime/connect?callSessionId=${call.id}`;
    const welcome =
      process.env.VOICE_WELCOME_MESSAGE ??
      "Hello, thank you for calling Coolfix Pro. We supply HVAC and refrigeration parts across the United States. How may I help you today?";

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${this.escapeXml(welcome)}</Say>
  <Connect>
    <Stream url="${this.escapeXml(streamUrl)}" />
  </Connect>
</Response>`;
  }

  @Post("recording")
  recording(@Body() body: any) {
    return { ok: true, recordingSid: body.RecordingSid, recordingUrl: body.RecordingUrl };
  }

  @Post("status")
  status(@Body() body: any) {
    return this.calls.updateFromTwilioStatus({
      callSid: body.CallSid,
      status: body.CallStatus,
      duration: body.CallDuration,
      rawPayload: body,
    });
  }

  private escapeXml(value: string) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  private isSmsIncoming(body: any) {
    return Boolean(body?.MessageSid || body?.SmsSid || (body?.Body && !body?.CallSid));
  }
}
