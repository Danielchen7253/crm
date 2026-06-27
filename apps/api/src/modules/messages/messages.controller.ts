import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, ServiceUnavailableException } from "@nestjs/common";
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
    const conversationId = body.conversationId ?? body.conversation_id;
    if (!conversationId) {
      throw new BadRequestException("conversationId is required");
    }

    const outboundText = body.text_content ?? body.text;
    if (!String(outboundText ?? "").trim()) {
      throw new BadRequestException("message text is required");
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { customer: { include: { identities: true } }, identity: true },
    });
    if (!conversation) {
      throw new NotFoundException("Conversation not found");
    }

    const fallbackChannelAccountId = conversation.channelAccountId
      ? null
      : (
          await this.prisma.channelAccount.findFirst({
            where: { channel: conversation.channel, isActive: true },
            orderBy: { createdAt: "asc" },
          })
        )?.id;

    const message = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        customerId: conversation.customerId,
        channelAccountId: conversation.channelAccountId ?? fallbackChannelAccountId,
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

    const delivery = await this.sender.send(conversation, message).catch(
      (error): {
        status: MessageStatus;
        provider: string;
        externalMessageId?: string;
        failedReason?: string;
        providerErrorCode?: string;
        providerErrorMessage?: string;
        raw?: unknown;
      } => ({
        status: MessageStatus.failed,
        provider: "send-service",
        failedReason: error instanceof Error ? error.message : "Unknown provider send error",
      }),
    );
    const deliveredMessage = await this.prisma.message.update({
      where: { id: message.id },
      data: {
        provider: delivery.provider,
        status: delivery.status,
        ...(message.channelAccountId ? { channelAccountId: message.channelAccountId } : {}),
        externalMessageId: delivery.externalMessageId ?? message.externalMessageId,
        failedReason: delivery.failedReason ?? message.failedReason ?? null,
        providerErrorCode: delivery.providerErrorCode ?? null,
        providerErrorMessage: delivery.providerErrorMessage ?? null,
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
    const message = await this.prisma.message.findUnique({ where: { id } });
    if (!message) {
      throw new NotFoundException("Message not found");
    }
    if (message.direction !== MessageDirection.outbound) {
      return { ok: false, reason: "Only outbound messages can be retried" };
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: message.conversationId },
      include: { customer: { include: { identities: true } }, identity: true },
    });
    if (!conversation) {
      throw new NotFoundException("Conversation not found");
    }
    const fallbackChannelAccountId = conversation.channelAccountId
      ? null
      : (
          await this.prisma.channelAccount.findFirst({
            where: { channel: conversation.channel, isActive: true },
            orderBy: { createdAt: "asc" },
          })
        )?.id;

    const queued = await this.prisma.message.update({
      where: { id },
      data: {
        status: MessageStatus.queued,
        failedReason: null,
        providerErrorCode: null,
        providerErrorMessage: null,
        ...(message.channelAccountId ? {} : fallbackChannelAccountId ? { channelAccountId: fallbackChannelAccountId } : {}),
      },
    });

    const delivery = await this.sender.send(conversation, queued).catch(
      (error): {
        status: MessageStatus;
        provider: string;
        externalMessageId?: string;
        failedReason?: string;
        providerErrorCode?: string;
        providerErrorMessage?: string;
        raw?: unknown;
      } => ({
        status: MessageStatus.failed,
        provider: "send-service",
        failedReason: error instanceof Error ? error.message : "Unknown provider send error",
      }),
    );
    const deliveredMessage = await this.prisma.message.update({
      where: { id },
      data: {
        provider: delivery.provider,
        status: delivery.status,
        ...(queued.channelAccountId || message.channelAccountId || fallbackChannelAccountId ? { channelAccountId: queued.channelAccountId ?? message.channelAccountId ?? fallbackChannelAccountId } : {}),
        externalMessageId: delivery.externalMessageId ?? message.externalMessageId,
        failedReason: delivery.failedReason ?? message.failedReason ?? null,
        providerErrorCode: delivery.providerErrorCode ?? null,
        providerErrorMessage: delivery.providerErrorMessage ?? null,
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
  uploadFilePlaceholder() {
    throw new ServiceUnavailableException(
      "File storage is not configured. Configure R2/S3 before enabling attachments.",
    );
  }

  @Post(":id/upload")
  uploadPlaceholder() {
    throw new ServiceUnavailableException(
      "File storage is not configured. Configure R2/S3 before enabling attachments.",
    );
  }
}
