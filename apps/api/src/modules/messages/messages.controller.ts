import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { MessageDirection, MessageStatus, MessageType } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

@Controller("messages")
export class MessagesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  @Get()
  list(@Query("conversationId") conversationId: string) {
    return this.prisma.message.findMany({
      where: { conversationId },
      include: { attachments: true, aiReplyLogs: true },
      orderBy: { sentAt: "asc" },
    });
  }

  @Post("send")
  async send(@Body() body: any) {
    const conversation = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: body.conversationId },
      include: { customer: true },
    });

    const message = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        customerId: conversation.customerId,
        channel: conversation.channel,
        provider: body.provider ?? "manual",
        direction: MessageDirection.outbound,
        type: (body.type as MessageType | undefined) ?? MessageType.text,
        status: MessageStatus.queued,
        text: body.text,
        sentAt: new Date(),
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), unreadCount: 0 },
    });

    this.realtime.emitInboxEvent("message.created", {
      customerId: conversation.customerId,
      conversationId: conversation.id,
      message,
    });

    return {
      message,
      delivery: "queued",
      note: "Provider sender adapter is intentionally separate; webhook/status callback will mark sent/delivered/failed.",
    };
  }

  @Post(":id/upload")
  uploadPlaceholder(@Param("id") id: string, @Body() body: any) {
    return {
      messageId: id,
      upload: "presigned-url-placeholder",
      fileName: body.fileName,
      contentType: body.contentType,
    };
  }
}
