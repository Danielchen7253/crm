import { Controller, Get } from "@nestjs/common";

const statusPayload = {
  name: "CoolFix Omni CRM API",
  status: "ok",
  docs: {
    health: "/api/auth/me",
    conversations: "/api/conversations",
    twilioIncoming: "/api/twilio/incoming",
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
