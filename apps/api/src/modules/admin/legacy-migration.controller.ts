import { Body, Controller, ForbiddenException, Post } from "@nestjs/common";
import { CallStatus, Channel, MessageDirection, MessageStatus, MessageType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

type LegacyCustomer = {
  id: string;
  display_name?: string;
  source?: string;
  first_seen_at?: string;
  last_seen_at?: string;
  last_message_at?: string;
  profile_pic_url?: string;
  locale?: string;
  timezone?: string;
  gender?: string;
  summary?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

type LegacyIdentity = {
  id: string;
  customer_id: string;
  provider: string;
  provider_user_id: string;
  display_name?: string;
  raw_profile?: Record<string, unknown>;
  created_at?: string;
};

type LegacyMessage = {
  id: string;
  customer_id: string;
  provider: string;
  provider_message_id?: string;
  direction?: string;
  message_type?: string;
  text?: string;
  attachments?: Array<Record<string, unknown>>;
  raw_event?: Record<string, unknown>;
  sent_at?: string;
  created_at?: string;
};

type LegacyCall = {
  id: string;
  customer_id?: string;
  provider?: string;
  provider_call_id?: string;
  from_phone?: string;
  to_phone?: string;
  status?: string;
  language?: string;
  transcript?: string;
  summary?: string;
  raw_event?: Record<string, unknown>;
  created_at?: string;
};

type LegacyNoteSource = {
  id: string;
  customer_id?: string;
  title?: string;
  source?: string;
  status?: string;
  need?: string;
  notes?: string;
  raw_context?: Record<string, unknown>;
  created_at?: string;
};

@Controller("admin")
export class LegacyMigrationController {
  constructor(private readonly prisma: PrismaService) {}

  @Post("migrate-legacy")
  async migrate(@Body("secret") secret?: string) {
    if (!process.env.MIGRATION_SECRET || secret !== process.env.MIGRATION_SECRET) {
      throw new ForbiddenException("Invalid migration secret");
    }

    let stage = "env";
    try {
    const legacyUrl = process.env.LEGACY_SUPABASE_URL;
    const legacyKey = process.env.LEGACY_SUPABASE_SERVICE_ROLE_KEY;
    if (!legacyUrl || !legacyKey) throw new Error("Missing legacy Supabase env vars");

    stage = "admin";
    const admin = await this.prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
    if (!admin) throw new Error("No admin user found for internal notes");

    const stats = {
      legacy: {
        customers: 0,
        identities: 0,
        messages: 0,
        calls: 0,
        followUps: 0,
        leads: 0,
      },
      created: {
        customers: 0,
        identities: 0,
        conversations: 0,
        messages: 0,
        attachments: 0,
        calls: 0,
        notes: 0,
      },
      skipped: {
        customers: 0,
        identities: 0,
        messages: 0,
        calls: 0,
        notes: 0,
      },
    };

    stage = "fetch legacy";
    const customers = await this.fetchAll<LegacyCustomer>(legacyUrl, legacyKey, "customers");
    const identities = await this.fetchAll<LegacyIdentity>(legacyUrl, legacyKey, "customer_identities");
    const messages = await this.fetchAll<LegacyMessage>(legacyUrl, legacyKey, "messages");
    const calls = await this.fetchAll<LegacyCall>(legacyUrl, legacyKey, "calls");
    const followUps = await this.fetchAll<LegacyNoteSource>(legacyUrl, legacyKey, "follow_up_tasks");
    const leads = await this.fetchAll<LegacyNoteSource>(legacyUrl, legacyKey, "leads");

    stats.legacy.customers = customers.length;
    stats.legacy.identities = identities.length;
    stats.legacy.messages = messages.length;
    stats.legacy.calls = calls.length;
    stats.legacy.followUps = followUps.length;
    stats.legacy.leads = leads.length;

    stage = "customers";
    const customerIdMap = new Map<string, string>();
    for (const legacy of customers) {
      const existing = await this.prisma.customer.findFirst({
        where: { metadata: { path: ["legacyId"], equals: legacy.id } },
      });
      if (existing) {
        customerIdMap.set(legacy.id, existing.id);
        stats.skipped.customers += 1;
        continue;
      }

      const customer = await this.prisma.customer.create({
        data: {
          displayName: legacy.display_name ?? this.metadataString(legacy.metadata, "display_name") ?? `Legacy customer ${legacy.id}`,
          source: this.toChannel(legacy.source) ?? Channel.messenger,
          avatarUrl: legacy.profile_pic_url,
          language: legacy.locale,
          summary: legacy.summary,
          lastMessageAt: this.dateOrUndefined(legacy.last_message_at),
          lastContactAt: this.dateOrUndefined(legacy.last_seen_at ?? legacy.last_message_at),
          metadata: this.json({
            legacyId: legacy.id,
            legacySource: legacy.source,
            legacyTags: legacy.tags ?? [],
            timezone: legacy.timezone,
            gender: legacy.gender,
            rawMetadata: legacy.metadata ?? {},
          }),
          createdAt: this.dateOrUndefined(legacy.created_at),
          updatedAt: this.dateOrUndefined(legacy.updated_at),
        },
      });
      customerIdMap.set(legacy.id, customer.id);
      stats.created.customers += 1;
    }

    stage = "identities";
    for (const legacy of identities) {
      const customerId = customerIdMap.get(legacy.customer_id);
      if (!customerId || !legacy.provider_user_id) {
        stats.skipped.identities += 1;
        continue;
      }

      const channel = this.toChannel(legacy.provider) ?? Channel.messenger;
      const existing = await this.prisma.customerIdentity.findUnique({
        where: { provider_externalId: { provider: legacy.provider, externalId: legacy.provider_user_id } },
      });
      if (existing) {
        stats.skipped.identities += 1;
        continue;
      }

      await this.prisma.customerIdentity.create({
        data: {
          customerId,
          channel,
          provider: legacy.provider,
          externalId: legacy.provider_user_id,
          displayName: legacy.display_name,
          rawProfile: {
            legacyId: legacy.id,
            ...(legacy.raw_profile ?? {}),
          },
          createdAt: this.dateOrUndefined(legacy.created_at),
        },
      });
      stats.created.identities += 1;
    }

    stage = "messages";
    for (const legacy of messages) {
      const customerId = customerIdMap.get(legacy.customer_id);
      if (!customerId) {
        stats.skipped.messages += 1;
        continue;
      }

      const fallbackDedupeKey = `legacy:${legacy.id}`;
      const existing = await this.prisma.message.findFirst({
        where: {
          OR: [
            { fallbackDedupeKey },
            { rawEvent: { path: ["legacyId"], equals: legacy.id } },
            legacy.provider_message_id
              ? { channel: this.toChannel(legacy.provider) ?? Channel.messenger, externalMessageId: legacy.provider_message_id }
              : { id: "00000000-0000-0000-0000-000000000000" },
          ],
        },
      });
      if (existing) {
        stats.skipped.messages += 1;
        continue;
      }

      const channel = this.toChannel(legacy.provider) ?? Channel.messenger;
      const externalThreadId = `legacy:${legacy.provider}:${legacy.customer_id}`;
      let conversation = await this.prisma.conversation.findUnique({
        where: { channel_externalThreadId: { channel, externalThreadId } },
      });
      if (!conversation) {
        conversation = await this.prisma.conversation.create({
          data: {
            customerId,
            channel,
            externalThreadId,
            status: "open",
            lastMessageAt: this.dateOrUndefined(legacy.sent_at ?? legacy.created_at),
            metadata: { legacyProvider: legacy.provider },
          },
        });
        stats.created.conversations += 1;
      }

      const message = await this.prisma.message.create({
        data: {
          conversationId: conversation.id,
          customerId,
          channel,
          provider: legacy.provider,
          externalMessageId: legacy.provider_message_id,
          fallbackDedupeKey: legacy.provider_message_id ? undefined : fallbackDedupeKey,
          direction: legacy.direction === "outbound" ? MessageDirection.outbound : MessageDirection.inbound,
          type: this.toMessageType(legacy.message_type, legacy.attachments),
          status: legacy.direction === "outbound" ? MessageStatus.sent : MessageStatus.received,
          text: legacy.text,
          rawEvent: { legacyId: legacy.id, ...(legacy.raw_event ?? {}) },
          sentAt: this.dateOrUndefined(legacy.sent_at ?? legacy.created_at) ?? new Date(),
        },
      });
      stats.created.messages += 1;

      for (const attachment of legacy.attachments ?? []) {
        const url = this.attachmentUrl(attachment);
        if (!url) continue;
        await this.prisma.messageAttachment.create({
          data: {
            messageId: message.id,
            type: this.toMessageType(String(attachment.type ?? attachment.message_type ?? "file")),
            url,
            mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : typeof attachment.mime_type === "string" ? attachment.mime_type : undefined,
            fileName: typeof attachment.fileName === "string" ? attachment.fileName : typeof attachment.filename === "string" ? attachment.filename : undefined,
            metadata: this.json({ legacyAttachment: attachment }),
          },
        });
        stats.created.attachments += 1;
      }

      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: this.dateOrUndefined(legacy.sent_at ?? legacy.created_at) ?? conversation.lastMessageAt },
      });
    }

    stage = "calls";
    for (const legacy of calls) {
      const customerId = legacy.customer_id ? customerIdMap.get(legacy.customer_id) : undefined;
      if (!customerId || !legacy.provider_call_id) {
        stats.skipped.calls += 1;
        continue;
      }
      const existing = await this.prisma.callSession.findUnique({ where: { twilioCallSid: legacy.provider_call_id } });
      if (existing) {
        stats.skipped.calls += 1;
        continue;
      }

      await this.prisma.callSession.create({
        data: {
          customerId,
          twilioCallSid: legacy.provider_call_id,
          fromPhone: legacy.from_phone ?? "",
          toPhone: legacy.to_phone ?? "",
          status: CallStatus.completed,
          language: legacy.language,
          startedAt: this.dateOrUndefined(legacy.created_at) ?? new Date(),
          endedAt: this.dateOrUndefined(legacy.created_at),
          summary: legacy.summary,
          metadata: this.json({
            legacyId: legacy.id,
            legacyProvider: legacy.provider,
            legacyStatus: legacy.status,
            transcript: legacy.transcript,
            rawEvent: legacy.raw_event ?? {},
          }),
        },
      });
      stats.created.calls += 1;
    }

    stage = "repair voice channels";
    await this.repairVoiceMessageChannels();
    stage = "cleanup test data";
    await this.removeCodexTestData();

    stage = "notes";
    for (const item of [...followUps, ...leads]) {
      const customerId = item.customer_id ? customerIdMap.get(item.customer_id) : undefined;
      if (!customerId) {
        stats.skipped.notes += 1;
        continue;
      }
      const legacyKey = `legacy-note:${item.id}`;
      const existing = await this.prisma.internalNote.findFirst({
        where: { customerId, body: { contains: legacyKey } },
      });
      if (existing) {
        stats.skipped.notes += 1;
        continue;
      }
      await this.prisma.internalNote.create({
        data: {
          customerId,
          authorId: admin.id,
          body: [
            legacyKey,
            item.title ? `Title: ${item.title}` : null,
            item.need ? `Need: ${item.need}` : null,
            item.status ? `Status: ${item.status}` : null,
            item.source ? `Source: ${item.source}` : null,
            item.notes ? `Notes: ${item.notes}` : null,
            `Raw: ${JSON.stringify(item.raw_context ?? {})}`,
          ]
            .filter(Boolean)
            .join("\n"),
          createdAt: this.dateOrUndefined(item.created_at),
        },
      });
      stats.created.notes += 1;
    }

    stage = "audit";
    await this.prisma.auditLog.create({
      data: {
        action: "legacy.migration",
        entityType: "migration",
        after: stats,
      },
    });

    stage = "verification";
    const verification = {
      customers: await this.prisma.customer.count(),
      identities: await this.prisma.customerIdentity.count(),
      conversations: await this.prisma.conversation.count(),
      messages: await this.prisma.message.count(),
      calls: await this.prisma.callSession.count(),
      notes: await this.prisma.internalNote.count(),
      latestConversations: await this.prisma.conversation.findMany({
        take: 5,
        orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
        include: { customer: true, messages: { take: 1, orderBy: { sentAt: "desc" } } },
      }),
    };

    return { ok: true, stats, verification };
    } catch (error) {
      return {
        ok: false,
        stage,
        error: error instanceof Error ? error.message : String(error),
        code: typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : undefined,
      };
    }
  }

  private async fetchAll<T>(baseUrl: string, key: string, table: string): Promise<T[]> {
    const pageSize = 1000;
    const rows: T[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/v1/${table}?select=*&offset=${offset}&limit=${pageSize}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (response.status === 404) return rows;
      if (!response.ok) throw new Error(`Legacy ${table} fetch failed ${response.status}: ${await response.text()}`);
      const batch = (await response.json()) as T[];
      rows.push(...batch);
      if (batch.length < pageSize) return rows;
    }
  }

  private toChannel(value?: string | null): Channel | undefined {
    if (!value) return undefined;
    const normalized = value.toLowerCase().replace(/[-\s]/g, "_");
    if (Object.values(Channel).includes(normalized as Channel)) return normalized as Channel;
    if (normalized.includes("voice") || normalized.includes("call")) return Channel.phone;
    if (normalized.includes("whatsapp") || normalized === "wa") return Channel.whatsapp;
    if (normalized.includes("twilio") || normalized.includes("sms") || normalized.includes("text")) return Channel.sms;
    if (normalized.includes("website") || normalized.includes("chat")) return Channel.website_chat;
    if (normalized.includes("instagram")) return Channel.instagram;
    if (normalized.includes("facebook") || normalized.includes("messenger") || normalized.includes("meta")) return Channel.messenger;
    return undefined;
  }

  private toMessageType(value?: string | null, attachments?: unknown[]): MessageType {
    const normalized = value?.toLowerCase();
    if (normalized && Object.values(MessageType).includes(normalized as MessageType)) return normalized as MessageType;
    if (attachments?.length) return MessageType.file;
    return MessageType.text;
  }

  private attachmentUrl(attachment: Record<string, unknown>) {
    for (const key of ["url", "link", "media_url", "href"]) {
      const value = attachment[key];
      if (typeof value === "string" && value) return value;
    }
    return undefined;
  }

  private dateOrUndefined(value?: string | null) {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private metadataString(metadata: unknown, key: string) {
    if (!metadata || typeof metadata !== "object") return undefined;
    const value = (metadata as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  }

  private json(value: unknown) {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }

  private async repairVoiceMessageChannels() {
    await this.removeDuplicateLegacyMessages();
    await this.removeDuplicateProviderMessages("twilio_voice");

    const conversations = await this.prisma.conversation.findMany({
      where: { externalThreadId: { startsWith: "legacy:twilio_voice:" } },
      orderBy: { createdAt: "asc" },
    });
    const byThread = new Map<string, typeof conversations>();
    for (const conversation of conversations) {
      const key = conversation.externalThreadId ?? conversation.id;
      byThread.set(key, [...(byThread.get(key) ?? []), conversation]);
    }

    for (const group of byThread.values()) {
      const target = group.find((conversation) => conversation.channel === Channel.phone) ?? group[0];
      if (target.channel !== Channel.phone) {
        await this.prisma.conversation.update({ where: { id: target.id }, data: { channel: Channel.phone } });
      }

      for (const duplicate of group) {
        if (duplicate.id === target.id) continue;
        await this.prisma.message.updateMany({
          where: { conversationId: duplicate.id },
          data: { conversationId: target.id, channel: Channel.phone },
        });
        await this.prisma.aiReplyLog.updateMany({
          where: { conversationId: duplicate.id },
          data: { conversationId: target.id },
        });
        await this.prisma.internalNote.updateMany({
          where: { conversationId: duplicate.id },
          data: { conversationId: target.id },
        });
        await this.prisma.callSession.updateMany({
          where: { conversationId: duplicate.id },
          data: { conversationId: target.id },
        });
        await this.prisma.conversation.delete({ where: { id: duplicate.id } });
      }
    }

    await this.prisma.message.updateMany({ where: { provider: "twilio_voice" }, data: { channel: Channel.phone } });
    await this.removeDuplicateLegacyMessages();
    await this.removeDuplicateProviderMessages("twilio_voice");
  }

  private async removeDuplicateLegacyMessages() {
    const legacyMessages = await this.prisma.message.findMany({
      where: { rawEvent: { path: ["legacyId"], not: Prisma.DbNull } },
      orderBy: { createdAt: "asc" },
    });
    const seen = new Set<string>();
    for (const message of legacyMessages) {
      const raw = message.rawEvent;
      const legacyId =
        raw && typeof raw === "object" && !Array.isArray(raw) && "legacyId" in raw
          ? String((raw as Record<string, unknown>).legacyId)
          : undefined;
      if (!legacyId) continue;
      if (!seen.has(legacyId)) {
        seen.add(legacyId);
        continue;
      }
      await this.prisma.message.delete({ where: { id: message.id } });
    }
  }

  private async removeDuplicateProviderMessages(provider: string) {
    const messages = await this.prisma.message.findMany({
      where: { provider, externalMessageId: { not: null } },
      orderBy: { createdAt: "asc" },
    });
    const seen = new Set<string>();
    for (const message of messages) {
      const key = `${message.provider}:${message.externalMessageId}`;
      if (!seen.has(key)) {
        seen.add(key);
        continue;
      }
      await this.prisma.message.delete({ where: { id: message.id } });
    }
  }

  private async removeCodexTestData() {
    const testMessages = await this.prisma.message.findMany({
      where: {
        OR: [
          { text: { contains: "CRM inbound test" } },
          { text: { contains: "CRM WhatsApp inbound test" } },
          { text: { contains: "CoolFix CRM WhatsApp live send path test" } },
          { text: { contains: "CoolFix CRM SMS live send test" } },
        ],
      },
      select: { conversationId: true, customerId: true },
    });
    const conversationIds = [...new Set(testMessages.map((message) => message.conversationId))];
    const customerIds = [...new Set(testMessages.map((message) => message.customerId))];
    if (conversationIds.length) {
      await this.prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    }
    for (const customerId of customerIds) {
      const remaining = await this.prisma.conversation.count({ where: { customerId } });
      const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
      if (remaining === 0 && !this.hasLegacyId(customer?.metadata)) {
        await this.prisma.customer.delete({ where: { id: customerId } }).catch(() => undefined);
      }
    }
  }

  private hasLegacyId(metadata: unknown) {
    return Boolean(metadata && typeof metadata === "object" && !Array.isArray(metadata) && "legacyId" in metadata);
  }
}
