import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Channel, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { DEFAULT_TAGS } from "./default-tags";

export type TagFilter = {
  all?: string[];
  any?: string[];
  none?: string[];
  q?: string;
};

@Injectable()
export class TagsService implements OnModuleInit {
  private readonly logger = new Logger(TagsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    const result = await this.seedDefaults();
    this.logger.log(`CRM tag library ready: ${result.count} default tags`);
  }

  async seedDefaults() {
    await this.ensureTagSchema();
    const results = [];
    for (const tag of DEFAULT_TAGS) {
      results.push(
        await this.prisma.tag.upsert({
          where: { name: tag.name },
          update: { groupName: tag.groupName, color: tag.color, description: tag.description, isActive: true },
          create: tag,
        }),
      );
    }
    return { count: results.length, tags: results };
  }

  async list(params: { q?: string; group?: string; active?: string }) {
    await this.ensureTagSchema();
    const isActive = params.active === undefined ? undefined : params.active !== "false";
    return this.prisma.tag.findMany({
      where: {
        ...(isActive === undefined ? {} : { isActive }),
        ...(params.group ? { groupName: params.group } : {}),
        ...(params.q
          ? {
              OR: [
                { name: { contains: params.q, mode: "insensitive" } },
                { groupName: { contains: params.q, mode: "insensitive" } },
                { description: { contains: params.q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: { _count: { select: { customers: true } } },
      orderBy: [{ groupName: "asc" }, { name: "asc" }],
    });
  }

  async upsertByName(input: { name: string; groupName?: string; color?: string; description?: string; isActive?: boolean }) {
    await this.ensureTagSchema();
    const name = input.name.trim();
    return this.prisma.tag.upsert({
      where: { name },
      update: {
        groupName: input.groupName,
        color: input.color,
        description: input.description,
        isActive: input.isActive ?? true,
      },
      create: {
        name,
        groupName: input.groupName,
        color: input.color ?? "#334155",
        description: input.description,
        isActive: input.isActive ?? true,
      },
    });
  }

  update(id: string, input: { name?: string; groupName?: string; color?: string; description?: string; isActive?: boolean }) {
    return this.prisma.tag.update({
      where: { id },
      data: {
        name: input.name?.trim(),
        groupName: input.groupName,
        color: input.color,
        description: input.description,
        isActive: input.isActive,
      },
    });
  }

  hide(id: string) {
    return this.prisma.tag.update({ where: { id }, data: { isActive: false } });
  }

  async merge(sourceTagId: string, targetTagId: string, actorId?: string) {
    const sourceAssignments = await this.prisma.customerTag.findMany({ where: { tagId: sourceTagId } });
    for (const assignment of sourceAssignments) {
      await this.prisma.customerTag.upsert({
        where: { customerId_tagId: { customerId: assignment.customerId, tagId: targetTagId } },
        update: {},
        create: { customerId: assignment.customerId, tagId: targetTagId, createdBy: actorId ?? assignment.createdBy },
      });
    }

    await this.prisma.$transaction([
      this.prisma.customerTag.deleteMany({ where: { tagId: sourceTagId } }),
      this.prisma.tag.update({ where: { id: sourceTagId }, data: { isActive: false, name: { set: `merged:${sourceTagId}` } } }),
      this.prisma.auditLog.create({
        data: {
          actorId,
          action: "tag.merge",
          entityType: "tag",
          entityId: targetTagId,
          before: { sourceTagId },
          after: { targetTagId, movedCustomers: sourceAssignments.length },
        },
      }),
    ]);

    return { sourceTagId, targetTagId, movedCustomers: sourceAssignments.length };
  }

  async assignToCustomer(customerId: string, input: { tagIds?: string[]; tagNames?: string[]; actorId?: string }) {
    const tagIds = await this.resolveTagIds(input.tagIds, input.tagNames);
    for (const tagId of tagIds) {
      await this.prisma.customerTag.upsert({
        where: { customerId_tagId: { customerId, tagId } },
        update: {},
        create: { customerId, tagId, createdBy: input.actorId },
      });
    }
    return this.prisma.customer.findUnique({
      where: { id: customerId },
      include: { tags: { include: { tag: true }, orderBy: { createdAt: "desc" } } },
    });
  }

  async bulkAssign(input: { customerIds: string[]; tagIds?: string[]; tagNames?: string[]; actorId?: string }) {
    const tagIds = await this.resolveTagIds(input.tagIds, input.tagNames);
    let assigned = 0;
    for (const customerId of input.customerIds ?? []) {
      for (const tagId of tagIds) {
        await this.prisma.customerTag.upsert({
          where: { customerId_tagId: { customerId, tagId } },
          update: {},
          create: { customerId, tagId, createdBy: input.actorId },
        });
        assigned += 1;
      }
    }
    return { customers: input.customerIds?.length ?? 0, tags: tagIds.length, assigned };
  }

  removeFromCustomer(customerId: string, tagId: string) {
    return this.prisma.customerTag.delete({ where: { customerId_tagId: { customerId, tagId } } });
  }

  async filterCustomers(filter: TagFilter) {
    return this.prisma.customer.findMany({
      where: this.customerWhereForFilter(filter),
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
      take: 500,
    });
  }

  customerWhereForFilter(filter: TagFilter = {}): Prisma.CustomerWhereInput {
    const all = this.cleanNames(filter.all);
    const any = this.cleanNames(filter.any);
    const none = this.cleanNames(filter.none);
    const and: Prisma.CustomerWhereInput[] = [{ deletedAt: null }];

    for (const name of all) {
      and.push({ tags: { some: { tag: { name: { equals: name, mode: "insensitive" }, isActive: true } } } });
    }

    if (any.length > 0) {
      and.push({
        OR: any.map((name) => ({ tags: { some: { tag: { name: { equals: name, mode: "insensitive" }, isActive: true } } } })),
      });
    }

    if (none.length > 0) {
      and.push({
        NOT: {
          OR: none.map((name) => ({ tags: { some: { tag: { name: { equals: name, mode: "insensitive" }, isActive: true } } } })),
        },
      });
    }

    if (filter.q?.trim()) {
      const q = filter.q.trim();
      and.push({
        OR: [
          { displayName: { contains: q, mode: "insensitive" } },
          { primaryPhone: { contains: q } },
          { primaryEmail: { contains: q, mode: "insensitive" } },
          { tags: { some: { tag: { name: { contains: q, mode: "insensitive" }, isActive: true } } } },
        ],
      });
    }

    return { AND: and };
  }

  async applyAutomaticTags(input: {
    customerId: string;
    channel?: Channel;
    text?: string | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
    purchasedProducts?: string[];
  }) {
    const tagNames = new Set<string>();
    if (input.channel === "messenger") tagNames.add("Messenger Lead");
    if (input.channel === "whatsapp") tagNames.add("WhatsApp Lead");
    if (input.channel === "website_chat") tagNames.add("Website Lead");

    const text = `${input.text ?? ""} ${(input.purchasedProducts ?? []).join(" ")}`.toLowerCase();
    const boughtText = /\b(bought|purchased|paid|ordered|order)\b/.test(text);
    if (text.includes("capacitor") || text.includes("cbb65")) {
      tagNames.add("Capacitor");
      if (boughtText) tagNames.add("Bought Capacitor");
    }
    if (text.includes("compressor")) {
      tagNames.add("Compressor");
      if (boughtText) tagNames.add("Bought Compressor");
    }
    if (text.includes("houston") || input.city?.toLowerCase() === "houston") {
      tagNames.add("Houston");
      tagNames.add("Texas");
      tagNames.add("USA");
    }
    if (input.state?.toLowerCase() === "texas" || input.state?.toLowerCase() === "tx") {
      tagNames.add("Texas");
      tagNames.add("USA");
    }

    if (tagNames.size === 0) return { assigned: 0, tags: [] };
    await this.assignToCustomer(input.customerId, { tagNames: [...tagNames] });
    return { assigned: tagNames.size, tags: [...tagNames] };
  }

  async importTags(tags: Array<{ name: string; groupName?: string; color?: string; description?: string }>) {
    const imported = [];
    for (const tag of tags ?? []) {
      if (tag.name?.trim()) imported.push(await this.upsertByName(tag));
    }
    return { count: imported.length, tags: imported };
  }

  private cleanNames(values?: string[]) {
    return (values ?? []).map((value) => value.trim()).filter(Boolean);
  }

  private async resolveTagIds(tagIds?: string[], tagNames?: string[]) {
    const ids = new Set((tagIds ?? []).filter(Boolean));
    for (const name of this.cleanNames(tagNames)) {
      const tag = await this.upsertByName({ name, color: "#334155", isActive: true });
      ids.add(tag.id);
    }
    return [...ids];
  }

  private async ensureTagSchema() {
    await this.prisma.$executeRawUnsafe(`ALTER TABLE "Tag" ADD COLUMN IF NOT EXISTS "group_name" TEXT`);
    await this.prisma.$executeRawUnsafe(`ALTER TABLE "Tag" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true`);
    await this.prisma.$executeRawUnsafe(`ALTER TABLE "CustomerTag" ADD COLUMN IF NOT EXISTS "id" UUID NOT NULL DEFAULT gen_random_uuid()`);
    await this.prisma.$executeRawUnsafe(`ALTER TABLE "CustomerTag" ADD COLUMN IF NOT EXISTS "created_by" UUID`);
  }
}
