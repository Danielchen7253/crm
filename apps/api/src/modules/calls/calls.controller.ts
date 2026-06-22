import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CallsService } from "./calls.service";

@Controller("call")
export class CallsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calls: CallsService,
  ) {}

  @Post("start")
  start(@Body() body: { fromPhone: string; toPhone: string; twilioCallSid?: string }) {
    return this.calls.startInboundCall(body);
  }

  @Post("end")
  end(@Body() body: { callSessionId: string; summary?: unknown }) {
    return this.calls.endCall(body.callSessionId, body.summary);
  }

  @Post(":id/transcript")
  transcript(@Param("id") id: string, @Body() body: any) {
    return this.calls.addTranscript({
      callSessionId: id,
      speaker: body.speaker,
      text: body.text,
      language: body.language,
      isFinal: body.isFinal,
      offsetMs: body.offsetMs,
      rawEvent: body,
    });
  }

  @Post(":id/handoff")
  handoff(@Param("id") id: string, @Body() body: { reason: string; confidence?: number }) {
    return this.calls.requireHandoff(id, body.reason, body.confidence);
  }

  @Get(":id")
  detail(@Param("id") id: string) {
    return this.prisma.callSession.findUnique({
      where: { id },
      include: {
        customer: true,
        conversation: true,
        transcripts: { orderBy: { createdAt: "asc" } },
        recordings: true,
        events: { orderBy: { createdAt: "asc" } },
        aiActions: true,
      },
    });
  }
}
