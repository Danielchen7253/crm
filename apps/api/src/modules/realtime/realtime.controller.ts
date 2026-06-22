import { Controller, Get, Query } from "@nestjs/common";

@Controller("realtime")
export class RealtimeController {
  @Get("connect")
  connectInfo(@Query("callSessionId") callSessionId: string) {
    return {
      callSessionId,
      protocol: "twilio-media-stream",
      ai: "openai-realtime",
      note: "Twilio connects here by WebSocket in production; HTTP response is for diagnostics only.",
    };
  }
}
