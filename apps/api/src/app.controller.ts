import { Controller, Get } from "@nestjs/common";

const statusPayload = {
  name: "CoolFix Omni CRM API",
  status: "ok",
  docs: {
    health: "/api/auth/me",
    conversations: "/api/conversations",
    twilioIncoming: "/api/webhooks/twilio/incoming (or /api/twilio/incoming for legacy SMS)",
    twilioStatus: "/api/webhooks/twilio/status",
    smsWebhook: "/api/webhooks/twilio/sms",
  },
};

@Controller()
export class AppController {
  @Get()
  root() {
    return statusPayload;
  }

  @Get("status")
  status() {
    return statusPayload;
  }
}
