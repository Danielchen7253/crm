import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { Channel } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Controller("conversations")
export class ConversationsController {
  constructor(private readonly prisma: PrismaService) {}

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
  assign(@Param("id") id: string, @Body("userId") userId: string) {
    return this.prisma.conversation.update({ where: { id }, data: { assignedToId: userId, status: "assigned" } });
  }

  @Patch(":id/close")
  close(@Param("id") id: string) {
    return this.prisma.conversation.update({ where: { id }, data: { status: "closed", closedAt: new Date() } });
  }

  @Patch(":id/reopen")
  reopen(@Param("id") id: string) {
    return this.prisma.conversation.update({ where: { id }, data: { status: "open", closedAt: null } });
  }
}
