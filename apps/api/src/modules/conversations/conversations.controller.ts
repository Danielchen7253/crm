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
  list(@Query("channel") channel?: Channel, @Query("q") q?: string) {
    return this.prisma.conversation.findMany({
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
        messages: { orderBy: { sentAt: "desc" }, take: 1 },
        assignedTo: true,
      },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      take: 100,
    });
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
}
