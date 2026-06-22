import { Body, Controller, Header, Post } from "@nestjs/common";
import { CallsService } from "./calls.service";

@Controller("twilio")
export class TwilioVoiceController {
  constructor(private readonly calls: CallsService) {}

  @Post("incoming")
  @Header("Content-Type", "text/xml")
  async incoming(@Body() body: any) {
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
    return { ok: true, callSid: body.CallSid, status: body.CallStatus };
  }

  private escapeXml(value: string) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
}
