import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("campaigns")
export class CampaignsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.campaign.findMany({
      include: { recipients: true, template: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  @Get(":id")
  detail(@Param("id") id: string) {
    return this.prisma.campaign.findUnique({
      where: { id },
      include: { recipients: { include: { customer: true } }, template: true },
    });
  }

  @Post()
  async create(@Body() body: any) {
    return this.prisma.campaign.create({
      data: {
        name: body.name,
        channel: body.channel,
        content: body.content,
        templateId: body.templateId,
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
        recipients: {
          create: (body.customerIds ?? []).map((customerId: string) => ({ customerId })),
        },
      },
      include: { recipients: true },
    });
  }

  @Post(":id/send")
  async send(@Param("id") id: string) {
    await this.prisma.campaign.update({ where: { id }, data: { status: "sending" } });
    return {
      id,
      status: "sending",
      note: "Campaign worker will use channel adapters, STOP/unsubscribe checks, templates, retries, and status callbacks.",
    };
  }
}
