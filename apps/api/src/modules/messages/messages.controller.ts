import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { MessageDirection, MessageStatus, MessageType } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { ChannelSenderService } from "./channel-sender.service";

@Controller("messages")
export class MessagesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly sender: ChannelSenderService,
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
      include: { customer: true, identity: true },
    });

    const message = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        customerId: conversation.customerId,
        channel: conversation.channel,
        provider: body.provider ?? "crm",
        direction: MessageDirection.outbound,
        type: (body.type as MessageType | undefined) ?? MessageType.text,
        status: MessageStatus.queued,
        text: body.text,
        sentAt: new Date(),
      },
    });

    const delivery = await this.sender.send(conversation, message);
    const deliveredMessage = await this.prisma.message.update({
      where: { id: message.id },
      data: {
        provider: delivery.provider,
        status: delivery.status,
        externalMessageId: delivery.externalMessageId,
        failedReason: delivery.failedReason,
        rawEvent: (delivery.raw as object | undefined) ?? {},
        deliveredAt: delivery.status === MessageStatus.sent ? new Date() : undefined,
      },
      include: { attachments: true, aiReplyLogs: true },
    });

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), unreadCount: 0 },
    });

    this.realtime.emitInboxEvent("message.created", {
      customerId: conversation.customerId,
      conversationId: conversation.id,
      message: deliveredMessage,
    });

    return {
      message: deliveredMessage,
      delivery: delivery.status,
      failedReason: delivery.failedReason,
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
