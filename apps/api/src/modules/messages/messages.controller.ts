import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { AiAction, MessageDirection, MessageStatus, MessageType } from "@prisma/client";
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
      where: { id: body.conversationId ?? body.conversation_id },
      include: { customer: { include: { identities: true } }, identity: true },
    });

    const outboundText = body.text_content ?? body.text;
    const message = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        customerId: conversation.customerId,
        channel: conversation.channel,
        provider: body.provider ?? "crm",
        externalConversationId: conversation.externalThreadId,
        senderType: "agent",
        direction: MessageDirection.outbound,
        type: (body.content_type as MessageType | undefined) ?? (body.type as MessageType | undefined) ?? MessageType.text,
        contentType: (body.content_type as MessageType | undefined) ?? (body.type as MessageType | undefined) ?? MessageType.text,
        status: MessageStatus.queued,
        text: outboundText,
        textContent: outboundText,
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
        providerErrorCode: delivery.providerErrorCode,
        providerErrorMessage: delivery.providerErrorMessage,
        rawEvent: (delivery.raw as object | undefined) ?? {},
        deliveredAt: delivery.status === MessageStatus.sent ? new Date() : undefined,
      },
      include: { attachments: true, aiReplyLogs: true },
    });

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), unreadCount: 0 },
    });

    await this.recordAiLearningSample({
      conversationId: conversation.id,
      messageId: deliveredMessage.id,
      aiReplyLogId: body.ai_reply_log_id ?? body.aiReplyLogId,
      finalText: outboundText,
      enabled: body.learning_sample !== false,
    });

    this.realtime.emitInboxEvent("message.created", {
      customerId: conversation.customerId,
      conversationId: conversation.id,
      message: deliveredMessage,
    });
    this.realtime.emitInboxEvent("message.status", {
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

  @Post(":id/retry")
  async retry(@Param("id") id: string) {
    const message = await this.prisma.message.findUniqueOrThrow({ where: { id } });
    if (message.direction !== MessageDirection.outbound) {
      return { ok: false, reason: "Only outbound messages can be retried" };
    }

    const conversation = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: message.conversationId },
      include: { customer: { include: { identities: true } }, identity: true },
    });

    const queued = await this.prisma.message.update({
      where: { id },
      data: {
        status: MessageStatus.queued,
        failedReason: null,
        providerErrorCode: null,
        providerErrorMessage: null,
      },
    });

    const delivery = await this.sender.send(conversation, queued);
    const deliveredMessage = await this.prisma.message.update({
      where: { id },
      data: {
        provider: delivery.provider,
        status: delivery.status,
        externalMessageId: delivery.externalMessageId ?? message.externalMessageId,
        failedReason: delivery.failedReason,
        providerErrorCode: delivery.providerErrorCode,
        providerErrorMessage: delivery.providerErrorMessage,
        rawEvent: (delivery.raw as object | undefined) ?? {},
        deliveredAt: delivery.status === MessageStatus.sent ? new Date() : undefined,
      },
      include: { attachments: true, aiReplyLogs: true },
    });

    this.realtime.emitInboxEvent("message.status", {
      customerId: conversation.customerId,
      conversationId: conversation.id,
      message: deliveredMessage,
    });

    return { message: deliveredMessage, delivery: delivery.status, failedReason: delivery.failedReason };
  }

  private async recordAiLearningSample(input: {
    conversationId: string;
    messageId: string;
    aiReplyLogId?: string;
    finalText?: string;
    enabled: boolean;
  }) {
    const finalText = String(input.finalText ?? "").trim();
    if (!input.enabled || !finalText) return;

    if (input.aiReplyLogId) {
      await this.prisma.aiReplyLog
        .update({
          where: { id: input.aiReplyLogId },
          data: {
            acceptedAt: new Date(),
            finalText,
          },
        })
        .catch(() => undefined);
      return;
    }

    await this.prisma.aiReplyLog.create({
      data: {
        messageId: input.messageId,
        conversationId: input.conversationId,
        detectedLanguage: "unknown",
        intent: "agent_manual_reply",
        suggestedReply: "",
        confidence: 1,
        action: AiAction.no_reply,
        acceptedAt: new Date(),
        finalText,
        rawResponse: {
          source: "mobile_composer",
          learning: "agent_manual_reply_without_ai_suggestion",
          outboundMessageId: input.messageId,
        },
      },
    });
  }

  @Post("upload")
  uploadFilePlaceholder(@Body() body: any) {
    return {
      id: `upload-${Date.now()}`,
      url: body.url ?? "",
      fileName: body.fileName,
      contentType: body.contentType,
      note: "File storage placeholder; wire to R2/S3 for production uploads.",
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
