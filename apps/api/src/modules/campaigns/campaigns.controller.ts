import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TagsService, type TagFilter } from "../tags/tags.service";

@Controller("campaigns")
export class CampaignsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tags: TagsService,
  ) {}

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
    const customerIds = await this.resolveRecipientIds(body.customerIds, body.tagFilter);
    return this.prisma.campaign.create({
      data: {
        name: body.name,
        channel: body.channel,
        content: body.content,
        templateId: body.templateId,
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
        metadata: body.tagFilter ? { tagFilter: body.tagFilter } : undefined,
        recipients: {
          create: customerIds.map((customerId: string) => ({ customerId })),
        },
      },
      include: { recipients: true },
    });
  }

  @Post("preview-recipients")
  async previewRecipients(@Body() body: { customerIds?: string[]; tagFilter?: TagFilter }) {
    const customerIds = await this.resolveRecipientIds(body.customerIds, body.tagFilter);
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: customerIds }, deletedAt: null },
      include: { tags: { include: { tag: true } } },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      take: 500,
    });
    return { count: customers.length, customers };
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

  private async resolveRecipientIds(customerIds?: string[], tagFilter?: TagFilter) {
    const ids = new Set((customerIds ?? []).filter(Boolean));
    if (tagFilter) {
      const customers = await this.tags.filterCustomers(tagFilter);
      for (const customer of customers) ids.add(customer.id);
    }
    return [...ids];
  }
}
