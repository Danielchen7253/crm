import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("customers")
export class CustomersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Query("q") q?: string) {
    return this.prisma.customer.findMany({
      where: q
        ? {
            deletedAt: null,
            OR: [
              { displayName: { contains: q, mode: "insensitive" } },
              { primaryPhone: { contains: q } },
              { primaryEmail: { contains: q, mode: "insensitive" } },
            ],
          }
        : { deletedAt: null },
      include: { tags: { include: { tag: true } }, identities: true },
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
}
