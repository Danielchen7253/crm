import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { Channel } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

@Controller("conversations")
export class ConversationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  @Get()
  async list(@Query("channel") channel?: Channel, @Query("q") q?: string, @Query("limit") limit = "1000") {
    const take = Math.min(Math.max(Number(limit) || 1000, 1), 2000);
    const conversations = await this.prisma.conversation.findMany({
      where: {
        channel,
        customer: q
          ? {
              OR: [
                { displayName: { contains: q, mode: "insensitive" } },
                { primaryPhone: { contains: q } },
                { primaryEmail: { contains: q, mode: "insensitive" } },
              ],
            }
          : undefined,
      },
      include: {
        customer: { include: { tags: { include: { tag: true } }, identities: true } },
        identity: true,
        messages: { orderBy: { sentAt: "desc" }, take: 1 },
        assignedTo: true,
      },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      take,
    });

    if (channel === Channel.messenger || channel === Channel.instagram) {
      return conversations.filter(this.isMetaValidConversation);
    }

    return conversations;
  }

  @Get(":id/messages")
  async messages(@Param("id") id: string, @Query("cursor") cursor?: string, @Query("limit") limit = "30") {
    const take = Math.min(Math.max(Number(limit) || 30, 1), 50);
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId: id,
        sentAt: cursor ? { lt: new Date(cursor) } : undefined,
      },
      include: { attachments: true, aiReplyLogs: true },
      orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
      take,
    });
    const ordered = rows.reverse();
    return {
      messages: ordered,
      nextCursor: ordered[0]?.sentAt?.toISOString() ?? null,
      hasMore: rows.length === take,
    };
  }

  @Post(":id/read")
  async read(@Param("id") id: string) {
    const conversation = await this.prisma.conversation.update({
      where: { id },
      data: { unreadCount: 0 },
      include: { customer: true },
    });
    this.realtime.emitInboxEvent("conversation.read", { conversationId: id, conversation });
    return { ok: true, conversation };
  }

  @Get(":id")
  detail(@Param("id") id: string) {
    return this.prisma.conversation.findUnique({
      where: { id },
      include: {
        customer: { include: { identities: true, tags: { include: { tag: true } }, notes: true } },
        messages: { include: { attachments: true, aiReplyLogs: true }, orderBy: { sentAt: "asc" } },
        assignedTo: true,
      },
    });
  }

  @Patch(":id/assign")
  async assign(@Param("id") id: string, @Body() body: { userId: string; actorId?: string }) {
    const before = await this.prisma.conversation.findUnique({ where: { id } });
    const conversation = await this.prisma.conversation.update({
      where: { id },
      data: { assignedToId: body.userId, status: "assigned" },
      include: { customer: true, assignedTo: true },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId: body.actorId,
        action: "conversation.assign",
        entityType: "conversation",
        entityId: id,
        before: before as object,
        after: conversation as object,
      },
    });
    this.realtime.emitInboxEvent("conversation.updated", conversation);
    return conversation;
  }

  @Patch(":id/close")
  async close(@Param("id") id: string, @Body("actorId") actorId?: string) {
    const before = await this.prisma.conversation.findUnique({ where: { id } });
    const conversation = await this.prisma.conversation.update({
      where: { id },
      data: { status: "closed", closedAt: new Date() },
      include: { customer: true, assignedTo: true },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action: "conversation.close",
        entityType: "conversation",
        entityId: id,
        before: before as object,
        after: conversation as object,
      },
    });
    this.realtime.emitInboxEvent("conversation.updated", conversation);
    return conversation;
  }

  @Patch(":id/reopen")
  async reopen(@Param("id") id: string, @Body("actorId") actorId?: string) {
    const before = await this.prisma.conversation.findUnique({ where: { id } });
    const conversation = await this.prisma.conversation.update({
      where: { id },
      data: { status: "open", closedAt: null },
      include: { customer: true, assignedTo: true },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action: "conversation.reopen",
        entityType: "conversation",
        entityId: id,
        before: before as object,
        after: conversation as object,
      },
    });
    this.realtime.emitInboxEvent("conversation.updated", conversation);
    return conversation;
  }

  private isMetaValidConversation = (conversation: {
    externalThreadId: string | null;
    identity?: { externalId?: string | null; externalUserId?: string | null } | null;
  }) => {
    return (
      this.isValidMetaThreadId(conversation.externalThreadId) ||
      this.isValidMetaThreadId(conversation.identity?.externalId) ||
      this.isValidMetaThreadId(conversation.identity?.externalUserId)
    );
  };

  private isValidMetaThreadId(value: string | null | undefined) {
    if (!value) return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("legacy:")) return false;
    if (trimmed.startsWith("marketplace:")) return true;
    if (trimmed.startsWith("m_") || trimmed.startsWith("ig_")) return false;
    return /^\d{5,30}$/.test(trimmed);
  }
}
