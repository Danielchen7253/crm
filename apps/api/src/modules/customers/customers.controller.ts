import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TagsService } from "../tags/tags.service";

@Controller("customers")
export class CustomersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tags: TagsService,
  ) {}

  @Get()
  list(@Query("q") q?: string, @Query("tagAll") tagAll?: string, @Query("tagAny") tagAny?: string, @Query("tagNone") tagNone?: string) {
    const tagWhere = this.tags.customerWhereForFilter({
      q,
      all: this.splitTags(tagAll),
      any: this.splitTags(tagAny),
      none: this.splitTags(tagNone),
    });
    return this.prisma.customer.findMany({
      where: tagWhere,
      include: {
        tags: { include: { tag: true } },
        identities: true,
        conversations: {
          orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
          take: 1,
          select: { id: true, channel: true, lastMessageAt: true },
        },
      },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      take: 200,
    });
  }

  @Get(":id")
  detail(@Param("id") id: string) {
    return this.prisma.customer.findUnique({
      where: { id },
      include: {
        identities: true,
        conversations: { orderBy: { lastMessageAt: "desc" } },
        tags: { include: { tag: true } },
        notes: true,
      },
    });
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: any) {
    return this.prisma.customer.update({
      where: { id },
      data: {
        displayName: body.displayName,
        primaryPhone: body.primaryPhone,
        primaryEmail: body.primaryEmail,
        language: body.language,
        summary: body.summary,
        metadata: body.metadata,
      },
    });
  }

  @Post("merge")
  async merge(@Body() body: { sourceCustomerId: string; targetCustomerId: string; actorId?: string }) {
    const { sourceCustomerId, targetCustomerId, actorId } = body;
    await this.prisma.$transaction([
      this.prisma.customerIdentity.updateMany({ where: { customerId: sourceCustomerId }, data: { customerId: targetCustomerId } }),
      this.prisma.conversation.updateMany({ where: { customerId: sourceCustomerId }, data: { customerId: targetCustomerId } }),
      this.prisma.message.updateMany({ where: { customerId: sourceCustomerId }, data: { customerId: targetCustomerId } }),
      this.prisma.customer.update({ where: { id: sourceCustomerId }, data: { deletedAt: new Date() } }),
      this.prisma.auditLog.create({
        data: {
          actorId,
          action: "customer.merge",
          entityType: "customer",
          entityId: targetCustomerId,
          before: { sourceCustomerId },
          after: { targetCustomerId },
        },
      }),
    ]);
    return this.detail(targetCustomerId);
  }

  private splitTags(value?: string) {
    return value
      ? value
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
      : [];
  }
}
