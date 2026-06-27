import { Injectable } from "@nestjs/common";
import { Channel, MessageDirection, MessageStatus, MessageType } from "@prisma/client";
import type { InboundAttachment, NormalizedInboundMessage } from "@coolfix-crm/shared";
import { IngestService } from "../inbox/ingest.service";
import { PrismaService } from "../prisma/prisma.service";

type SyncStatus = {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  conversationsSeen: number;
  customersEnsured: number;
  messagesImported: number;
  messagesSkipped: number;
  errors: number;
  lastError?: string;
};

type MetaChannel = Extract<Channel, "messenger" | "instagram" | "whatsapp">;
type MarketplaceRecord = {
  role: string;
  fbid: string;
  title: string;
  customerName: string;
  sentAt: string;
};

type GraphPage<T> = {
  data?: T[];
  paging?: { next?: string };
  error?: { message?: string; code?: number; type?: string };
};

type GraphConversation = {
  id: string;
  updated_time?: string;
  participants?: { data?: Array<{ id: string; name?: string; email?: string }> };
};

type GraphMessage = {
  id: string;
  created_time?: string;
  from?: { id?: string; name?: string; email?: string };
  message?: string;
  attachments?: { data?: GraphAttachment[] };
};

type GraphAttachment = {
  id?: string;
  name?: string;
  size?: number;
  mime_type?: string;
  file_url?: string;
  image_data?: { url?: string; preview_url?: string };
  video_data?: { url?: string; preview_url?: string };
};

@Injectable()
export class MessengerSyncService {
  private status: SyncStatus = {
    running: false,
    conversationsSeen: 0,
    customersEnsured: 0,
    messagesImported: 0,
    messagesSkipped: 0,
    errors: 0,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: IngestService,
  ) {}

  getStatus() {
    return this.status;
  }

  start(options: { limit?: number; messagesPerConversation?: number } = {}) {
    if (this.status.running) return { started: false, status: this.status };
    this.status = {
      running: true,
      startedAt: new Date().toISOString(),
      conversationsSeen: 0,
      customersEnsured: 0,
      messagesImported: 0,
      messagesSkipped: 0,
      errors: 0,
    };
    void this.run(options).catch((error) => {
      this.status.running = false;
      this.status.finishedAt = new Date().toISOString();
      this.status.errors += 1;
      this.status.lastError = error instanceof Error ? error.message : String(error);
      console.error("Messenger sync failed", error);
    });
    return { started: true, status: this.status };
  }

  async repairMessengerConversations() {
    return this.repairMetaConversations([Channel.messenger]);
  }

  async cleanupTestRecord(psid?: string) {
    const normalizedPsid = this.normalizeTestPsid(psid);
    if (!normalizedPsid) {
      return { ok: false, reason: "Only explicit Messenger test PSIDs can be cleaned up" };
    }

    const conversations = await this.prisma.conversation.findMany({
      where: { channel: Channel.messenger, externalThreadId: normalizedPsid },
    });
    const identities = await this.prisma.customerIdentity.findMany({
      where: { channel: Channel.messenger, externalId: normalizedPsid },
    });
    const customerIds = new Set<string>([
      ...conversations.map((conversation) => conversation.customerId),
      ...identities.map((identity) => identity.customerId),
    ]);

    let messagesDeleted = 0;
    for (const conversation of conversations) {
      const messages = await this.prisma.message.findMany({
        where: { conversationId: conversation.id },
        select: { id: true },
      });
      const messageIds = messages.map((message) => message.id);
      if (messageIds.length) {
        await this.prisma.messageAttachment.deleteMany({ where: { messageId: { in: messageIds } } });
      }
      await this.prisma.aiReplyLog.deleteMany({ where: { conversationId: conversation.id } });
      const deletedMessages = await this.prisma.message.deleteMany({ where: { conversationId: conversation.id } });
      messagesDeleted += deletedMessages.count;
      await this.prisma.conversation.delete({ where: { id: conversation.id } });
    }

    for (const identity of identities) {
      await this.prisma.customerIdentity.delete({ where: { id: identity.id } });
    }

    let customersDeleted = 0;
    for (const customerId of customerIds) {
      const [remainingIdentities, remainingConversations] = await Promise.all([
        this.prisma.customerIdentity.count({ where: { customerId } }),
        this.prisma.conversation.count({ where: { customerId } }),
      ]);
      if (remainingIdentities || remainingConversations) continue;
      await this.prisma.customerTag.deleteMany({ where: { customerId } });
      await this.prisma.internalNote.deleteMany({ where: { customerId } });
      await this.prisma.customer.delete({ where: { id: customerId } });
      customersDeleted += 1;
    }

    return {
      ok: true,
      psid: normalizedPsid,
      conversationsDeleted: conversations.length,
      identitiesDeleted: identities.length,
      messagesDeleted,
      customersDeleted,
    };
  }

  async cleanupDirtyData(dryRun = true) {
    const testTextPatterns = [
      "CRM inbound test",
      "CRM live inbound test",
      "CRM outbound path test",
      "CRM WhatsApp inbound test",
      "CRM WhatsApp inbound connection test",
      "CoolFix CRM WhatsApp live send path test",
      "CoolFix CRM SMS live send test",
      "CRM Twilio test",
      "CRM signed Twilio webhook test",
      "[channel-smoke-",
      "channel-smoke-",
      "temporary delete verification",
      "not a real customer",
    ];

    const testMessages = await this.prisma.message.findMany({
      where: { OR: testTextPatterns.map((text) => ({ text: { contains: text, mode: "insensitive" as const } })) },
      select: { id: true, conversationId: true, customerId: true, provider: true, externalMessageId: true },
    });

    const duplicateMessages = await this.findDuplicateProviderMessages();
    const messageIds = [...new Set([...testMessages.map((message) => message.id), ...duplicateMessages.map((message) => message.id)])];
    const touchedConversationIds = [...new Set([...testMessages, ...duplicateMessages].map((message) => message.conversationId))];
    const touchedCustomerIds = [...new Set([...testMessages, ...duplicateMessages].map((message) => message.customerId))];

    const invalidMetaConversations = await this.prisma.conversation.findMany({
      where: {
        channel: { in: [Channel.messenger, Channel.instagram] },
        OR: [
          { externalThreadId: { startsWith: "legacy:" } },
          { externalThreadId: { startsWith: "m_" } },
          { externalThreadId: { startsWith: "ig_" } },
          { externalThreadId: { startsWith: "test" } },
          { externalThreadId: { startsWith: "debug" } },
          { externalThreadId: { startsWith: "smoke" } },
          { externalThreadId: { startsWith: "psid-debug" } },
        ],
      },
      include: { messages: { select: { id: true }, take: 1 } },
    });
    const invalidEmptyConversationIds = invalidMetaConversations
      .filter((conversation) => conversation.messages.length === 0 || touchedConversationIds.includes(conversation.id))
      .map((conversation) => conversation.id);

    const inactiveMaterials = await this.prisma.aiTrainingMaterial.findMany({
      where: { isActive: false },
      select: { id: true },
    });
    const fakeCustomers = await this.findFakeCustomers();

    const fullyDirtyConversations = await this.findFullyDirtyConversations(touchedConversationIds, messageIds);
    const fakeConversationIds = fakeCustomers.flatMap((customer) => customer.conversations.map((conversation) => conversation.id));
    const fakeMessageIds = fakeCustomers.flatMap((customer) => customer.messages.map((message) => message.id));
    const emptyConversations = await this.findEmptyConversations([...touchedConversationIds, ...invalidEmptyConversationIds, ...fakeConversationIds]);
    const globalEmptyConversations = await this.findGlobalEmptyConversations();
    const conversationIds = [
      ...new Set([
        ...invalidEmptyConversationIds,
        ...fakeConversationIds,
        ...fullyDirtyConversations.map((conversation) => conversation.id),
        ...emptyConversations.map((conversation) => conversation.id),
        ...globalEmptyConversations.map((conversation) => conversation.id),
      ]),
    ];
    const customerIds = [
      ...new Set([
        ...touchedCustomerIds,
        ...fakeCustomers.map((customer) => customer.id),
        ...emptyConversations.map((conversation) => conversation.customerId),
        ...globalEmptyConversations.map((conversation) => conversation.customerId),
      ]),
    ];
    const emptyCustomers = await this.findEmptyCustomers(customerIds);

    const plan = {
      dryRun,
      testMessages: testMessages.length,
      duplicateMessages: duplicateMessages.length,
      messagesToDelete: [...new Set([...messageIds, ...fakeMessageIds])].length,
      invalidMetaConversations: invalidEmptyConversationIds.length,
      fullyDirtyConversations: fullyDirtyConversations.length,
      fakeCustomers: fakeCustomers.length,
      emptyConversations: emptyConversations.length,
      globalEmptyConversations: globalEmptyConversations.length,
      conversationsToDelete: conversationIds.length,
      inactiveAiMaterials: inactiveMaterials.length,
      emptyCustomers: [...new Set([...emptyCustomers.map((customer) => customer.id), ...fakeCustomers.map((customer) => customer.id)])].length,
    };

    if (dryRun) return { ok: true, ...plan };

    const allMessageIds = [...new Set([...messageIds, ...fakeMessageIds])];
    if (allMessageIds.length) {
      await this.prisma.messageAttachment.deleteMany({ where: { messageId: { in: allMessageIds } } });
      await this.prisma.aiReplyLog.deleteMany({ where: { messageId: { in: allMessageIds } } });
      await this.prisma.message.deleteMany({ where: { id: { in: allMessageIds } } });
    }

    if (conversationIds.length) {
      await this.prisma.aiReplyLog.deleteMany({ where: { conversationId: { in: conversationIds } } });
      await this.prisma.internalNote.deleteMany({ where: { conversationId: { in: conversationIds } } });
      await this.prisma.callSession.updateMany({ where: { conversationId: { in: conversationIds } }, data: { conversationId: null } });
      await this.prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    }

    if (inactiveMaterials.length) {
      await this.prisma.aiTrainingMaterial.deleteMany({ where: { id: { in: inactiveMaterials.map((item) => item.id) } } });
    }

    const allEmptyCustomerIds = [...new Set([...emptyCustomers.map((customer) => customer.id), ...fakeCustomers.map((customer) => customer.id)])];
    if (allEmptyCustomerIds.length) {
      const ids = allEmptyCustomerIds;
      await this.prisma.customerTag.deleteMany({ where: { customerId: { in: ids } } });
      await this.prisma.internalNote.deleteMany({ where: { customerId: { in: ids } } });
      await this.prisma.callSession.deleteMany({ where: { customerId: { in: ids } } });
      await this.prisma.customerPhone.deleteMany({ where: { customerId: { in: ids } } });
      await this.prisma.customer.deleteMany({ where: { id: { in: ids } } });
    }

    await this.recomputeLastMessageAt([...customerIds, ...emptyCustomers.map((customer) => customer.id)]);
    return { ok: true, ...plan };
  }

  async importMarketplaceRecords(input: Array<Record<string, unknown>>) {
    const records = input
      .map((item): MarketplaceRecord | null => {
        const role = String(item.role ?? "seller");
        const fbid = String(item.fbid ?? "").trim();
        const title = String(item.title ?? "Facebook Marketplace inquiry").trim();
        const customerName = String(item.customerName ?? "").trim().replace(/\s+/g, " ");
        const sentAt = String(item.sentAt ?? "");
        if (!fbid || !customerName || Number.isNaN(new Date(sentAt).getTime())) return null;
        return { role, fbid, title, customerName, sentAt };
      })
      .filter((record): record is MarketplaceRecord => Boolean(record));

    let imported = 0;
    let skipped = input.length - records.length;
    const customers = new Set<string>();
    const tagCounts = new Map<string, number>();

    for (const record of records) {
      const result = await this.importMarketplaceRecord(record);
      if (result.imported) imported += 1;
      else skipped += 1;
      customers.add(result.customerId);
      for (const tag of result.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }

    return {
      ok: true,
      received: input.length,
      valid: records.length,
      imported,
      skipped,
      customersTouched: customers.size,
      tagCounts: Object.fromEntries([...tagCounts.entries()].sort((a, b) => b[1] - a[1])),
    };
  }

  async repairMetaConversations(channels: Channel[] = [Channel.messenger, Channel.instagram, Channel.whatsapp]) {
    const requestChannels = channels.filter((channel): channel is MetaChannel =>
      this.isMetaFamilyChannel(channel),
    );
    const details = [];
    for (const channel of requestChannels) {
      details.push(await this.repairMetaConversationsByChannel(channel));
    }
    const total = details.reduce(
      (acc, item) => {
        acc.inspected += item.inspected;
        acc.updated += item.updated;
        acc.merged += item.merged;
        acc.skipped += item.skipped;
        return acc;
      },
      { channels: requestChannels, inspected: 0, updated: 0, merged: 0, skipped: 0 },
    );
    return { ...total, details };
  }

  private async findDuplicateProviderMessages() {
    const messages = await this.prisma.message.findMany({
      where: { externalMessageId: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { id: true, conversationId: true, customerId: true, provider: true, channel: true, externalMessageId: true },
    });
    const seen = new Set<string>();
    const duplicates: typeof messages = [];
    for (const message of messages) {
      const key = `${message.channel}:${message.provider}:${message.externalMessageId}`;
      if (seen.has(key)) {
        duplicates.push(message);
        continue;
      }
      seen.add(key);
    }
    return duplicates;
  }

  private async importMarketplaceRecord(record: MarketplaceRecord) {
    const sentAt = new Date(record.sentAt);
    const externalIdentityId = `marketplace-name:${this.identityKey(record.customerName)}`;
    const identity = await this.prisma.customerIdentity.findUnique({
      where: { provider_externalId: { provider: "facebook_marketplace", externalId: externalIdentityId } },
      include: { customer: true },
    });

    const customer =
      identity?.customer ??
      (await this.prisma.customer.create({
        data: {
          displayName: record.customerName,
          source: Channel.messenger,
          lastMessageAt: sentAt,
          lastContactAt: sentAt,
          metadata: {
            importedFrom: "facebook_marketplace_export",
            importedBy: "admin/import-marketplace",
          },
        },
      }));

    if (!identity) {
      await this.prisma.customerIdentity.create({
        data: {
          customerId: customer.id,
          channel: Channel.messenger,
          provider: "facebook_marketplace",
          externalId: externalIdentityId,
          displayName: record.customerName,
          lastSeenAt: sentAt,
          rawProfile: {
            source: "facebook_marketplace_export",
            role: record.role,
          },
        },
      });
    }

    const tagSpecs = this.inferredMarketplaceTagSpecs(record.title);
    for (const spec of tagSpecs) {
      const tag = await this.prisma.tag.upsert({
        where: { name: spec.name },
        update: { groupName: spec.groupName, color: spec.color, isActive: true },
        create: { name: spec.name, groupName: spec.groupName, color: spec.color, isActive: true },
      });
      await this.prisma.customerTag
        .upsert({
          where: { customerId_tagId: { customerId: customer.id, tagId: tag.id } },
          update: {},
          create: { customerId: customer.id, tagId: tag.id },
        })
        .catch(() => undefined);
    }

    const externalThreadId = `marketplace:${record.fbid}`;
    const conversation = await this.prisma.conversation.upsert({
      where: { channel_externalThreadId: { channel: Channel.messenger, externalThreadId } },
      update: {
        customerId: customer.id,
        lastMessageAt: sentAt,
        metadata: {
          source: "facebook_marketplace_export",
          role: record.role,
          fbid: record.fbid,
          listingTitle: record.title,
        },
      },
      create: {
        customerId: customer.id,
        channel: Channel.messenger,
        externalThreadId,
        status: "new",
        lastMessageAt: sentAt,
        metadata: {
          source: "facebook_marketplace_export",
          role: record.role,
          fbid: record.fbid,
          listingTitle: record.title,
        },
      },
    });

    const fallbackDedupeKey = `facebook-marketplace:${record.role}:${record.fbid}`;
    const existing = await this.prisma.message.findUnique({ where: { fallbackDedupeKey } });
    if (existing) {
      return { imported: false, customerId: customer.id, tags: tagSpecs.map((tag) => tag.name) };
    }

    const text =
      record.role === "seller"
        ? `Facebook Marketplace inquiry about: ${record.title}`
        : `Facebook Marketplace contact you messaged about: ${record.title}`;
    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        customerId: customer.id,
        channel: Channel.messenger,
        provider: "facebook-marketplace-export",
        externalConversationId: externalThreadId,
        fallbackDedupeKey,
        senderType: record.role === "seller" ? "customer" : "agent",
        direction: record.role === "seller" ? MessageDirection.inbound : MessageDirection.outbound,
        type: MessageType.text,
        contentType: MessageType.text,
        status: record.role === "seller" ? MessageStatus.received : MessageStatus.sent,
        text,
        textContent: text,
        rawEvent: {
          source: "facebook_marketplace_export",
          role: record.role,
          fbid: record.fbid,
          listingTitle: record.title,
          customerName: record.customerName,
        },
        sentAt,
      },
    });

    await this.prisma.customer.update({
      where: { id: customer.id },
      data: { lastMessageAt: sentAt, lastContactAt: sentAt },
    });
    return { imported: true, customerId: customer.id, tags: tagSpecs.map((tag) => tag.name) };
  }

  private inferredMarketplaceTagSpecs(title: string) {
    const text = title.toLowerCase();
    const tags: Array<{ name: string; groupName: string; color: string }> = [
      { name: "Marketplace Lead", groupName: "Marketing", color: "#2563eb" },
      { name: "Facebook Lead", groupName: "Marketing", color: "#1877f2" },
    ];

    if (/\bhvac\b|air\s*condition|a\/c|ac\s/.test(text)) tags.push({ name: "HVAC", groupName: "Industry", color: "#0ea5e9" });
    if (/refrigeration|cooler|freezer|ice\s*machine/.test(text)) tags.push({ name: "Refrigeration", groupName: "Industry", color: "#06b6d4" });
    if (/capacitor|cbb65|\buf\b/.test(text)) tags.push({ name: "Capacitor", groupName: "Product Interest", color: "#f59e0b" });
    if (/contactor/.test(text)) tags.push({ name: "Contactor", groupName: "Product Interest", color: "#f97316" });
    if (/relay/.test(text)) tags.push({ name: "Potential Relay", groupName: "Product Interest", color: "#eab308" });
    if (/thermostat/.test(text)) tags.push({ name: "Thermostat", groupName: "Product Interest", color: "#22c55e" });
    if (/compressor/.test(text)) tags.push({ name: "Compressor", groupName: "Product Interest", color: "#ef4444" });
    if (/motor/.test(text)) tags.push({ name: "Fan Motor", groupName: "Product Interest", color: "#8b5cf6" });
    if (/transformer/.test(text)) tags.push({ name: "Transformer", groupName: "Product Interest", color: "#6366f1" });
    if (/gasket/.test(text)) tags.push({ name: "Door Gasket", groupName: "Product Interest", color: "#14b8a6" });
    if (/wholesale|bulk|contractor/.test(text)) tags.push({ name: "Wholesale", groupName: "Customer Level", color: "#7c3aed" });
    if (/houston|pickup/.test(text)) {
      tags.push({ name: "Houston", groupName: "Region", color: "#16a34a" });
      tags.push({ name: "Texas", groupName: "Region", color: "#15803d" });
      tags.push({ name: "USA", groupName: "Region", color: "#64748b" });
    }

    const seen = new Set<string>();
    return tags.filter((tag) => {
      const key = tag.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private identityKey(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u00c0-\uffff]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120);
  }

  private async findEmptyConversations(candidateIds: string[]) {
    const ids = [...new Set(candidateIds)].filter(Boolean);
    if (!ids.length) return [];
    const conversations = await this.prisma.conversation.findMany({
      where: { id: { in: ids } },
      include: { messages: { select: { id: true }, take: 1 } },
    });
    return conversations.filter((conversation) => conversation.messages.length === 0);
  }

  private async findGlobalEmptyConversations() {
    const conversations = await this.prisma.conversation.findMany({
      where: { lastMessageAt: null },
      include: { messages: { select: { id: true }, take: 1 } },
      take: 500,
    });
    return conversations.filter((conversation) => conversation.messages.length === 0);
  }

  private async findFakeCustomers() {
    const fakePhones = [
      "12065550000",
      "+12065550000",
      "15550001111",
      "+15550001111",
      "17135550123",
      "+17135550123",
      "17135550124",
      "+17135550124",
    ];
    return this.prisma.customer.findMany({
      where: {
        OR: [
          { displayName: { equals: "Test User", mode: "insensitive" } },
          { displayName: { equals: "Tester", mode: "insensitive" }, primaryPhone: { in: fakePhones } },
          { primaryPhone: { in: fakePhones } },
        ],
      },
      include: {
        conversations: { select: { id: true } },
        messages: { select: { id: true } },
      },
    });
  }

  private async findFullyDirtyConversations(candidateIds: string[], dirtyMessageIds: string[]) {
    const ids = [...new Set(candidateIds)].filter(Boolean);
    const dirty = new Set(dirtyMessageIds);
    if (!ids.length || !dirty.size) return [];
    const conversations = await this.prisma.conversation.findMany({
      where: { id: { in: ids } },
      include: { messages: { select: { id: true } } },
    });
    return conversations.filter(
      (conversation) =>
        conversation.messages.length > 0 &&
        conversation.messages.every((message) => dirty.has(message.id)),
    );
  }

  private async findEmptyCustomers(candidateIds: string[]) {
    const ids = [...new Set(candidateIds)].filter(Boolean);
    if (!ids.length) return [];
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: ids } },
      include: {
        identities: { select: { id: true }, take: 1 },
        conversations: { select: { id: true }, take: 1 },
        messages: { select: { id: true }, take: 1 },
        callSessions: { select: { id: true }, take: 1 },
        phones: { select: { id: true }, take: 1 },
      },
    });
    return customers.filter(
      (customer) =>
        customer.identities.length === 0 &&
        customer.conversations.length === 0 &&
        customer.messages.length === 0 &&
        customer.callSessions.length === 0 &&
        customer.phones.length === 0,
    );
  }

  private async recomputeLastMessageAt(customerIds: string[]) {
    const ids = [...new Set(customerIds)].filter(Boolean);
    for (const customerId of ids) {
      const conversations = await this.prisma.conversation.findMany({
        where: { customerId },
        include: { messages: { orderBy: { sentAt: "desc" }, take: 1 } },
      });
      let latest: Date | null = null;
      for (const conversation of conversations) {
        const conversationLatest = conversation.messages[0]?.sentAt ?? null;
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: conversationLatest },
        });
        latest = this.maxDate(latest, conversationLatest);
      }
      await this.prisma.customer.update({ where: { id: customerId }, data: { lastMessageAt: latest, lastContactAt: latest } }).catch(() => undefined);
    }
  }

  private async repairMetaConversationsByChannel(channel: MetaChannel) {
    const identities = await this.prisma.customerIdentity.findMany({
      where: { channel },
      include: { conversations: true },
    });

    let inspected = 0;
    let updated = 0;
    let merged = 0;
    let skipped = 0;

    for (const identity of identities) {
      inspected += 1;
      const canonicalThreadId = this.pickMetaThreadId(identity.externalId, identity.externalUserId);
      if (!canonicalThreadId) {
        skipped += 1;
        continue;
      }

      const staleConversations = identity.conversations.filter((conversation) => conversation.externalThreadId !== canonicalThreadId);
      const target = await this.prisma.conversation.findUnique({
        where: { channel_externalThreadId: { channel, externalThreadId: canonicalThreadId } },
      });

      if (!target) {
        const first = staleConversations[0];
        if (!first) {
          skipped += 1;
          continue;
        }
        await this.prisma.conversation.update({
          where: { id: first.id },
          data: {
            externalThreadId: canonicalThreadId,
            metadata: {
              ...(first.metadata as object),
              repairedFromExternalThreadId: first.externalThreadId,
              repairedBy: "repairMetaConversations",
              repairedAt: new Date().toISOString(),
            },
          },
        });
        updated += 1;
        continue;
      }

      let targetLastMessageAt = target.lastMessageAt;
      for (const stale of staleConversations) {
        if (stale.id === target.id) continue;
        await this.prisma.$transaction([
          this.prisma.message.updateMany({ where: { conversationId: stale.id }, data: { conversationId: target.id } }),
          this.prisma.aiReplyLog.updateMany({ where: { conversationId: stale.id }, data: { conversationId: target.id } }),
          this.prisma.internalNote.updateMany({ where: { conversationId: stale.id }, data: { conversationId: target.id } }),
          this.prisma.callSession.updateMany({ where: { conversationId: stale.id }, data: { conversationId: target.id } }),
          this.prisma.conversation.delete({ where: { id: stale.id } }),
        ]);
        targetLastMessageAt = this.maxDate(targetLastMessageAt, stale.lastMessageAt);
        merged += 1;
      }
    await this.prisma.conversation.update({
      where: { id: target.id },
      data: {
        lastMessageAt: targetLastMessageAt ?? null,
        identityId: target.identityId ?? identity.id,
        unreadCount: Math.max(target.unreadCount, staleConversations.length),
      },
    });
    }

    return { channel, inspected, updated, merged, skipped };
  }

  private pickMetaThreadId(first?: string | null, second?: string | null) {
    return this.normalizeMetaThreadId(first) ?? this.normalizeMetaThreadId(second);
  }

  private maxDate(left?: Date | null, right?: Date | null): Date | null {
    if (!left) return right ?? null;
    if (!right) return left;
    return left > right ? left : right;
  }

  private isMetaFamilyChannel(channel: Channel): channel is MetaChannel {
    return channel === Channel.messenger || channel === Channel.instagram || channel === Channel.whatsapp;
  }

  private normalizeMetaThreadId(value?: string | null) {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("legacy:") || trimmed.startsWith("m_") || trimmed.startsWith("ig_")) return undefined;
    if (!/^\d{5,30}$/.test(trimmed)) return undefined;
    return trimmed;
  }

  private normalizeTestPsid(value?: string | null) {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (/^9{8,30}$/.test(trimmed)) return trimmed;
    if (/^(test|psid-debug|debug|smoke)[\w:-]{0,80}$/i.test(trimmed)) return trimmed;
    return undefined;
  }

  private async run(options: { limit?: number; messagesPerConversation?: number }) {
    const token = process.env.MESSENGER_PAGE_ACCESS_TOKEN ?? process.env.PAGE_ACCESS_TOKEN ?? process.env.META_PAGE_ACCESS_TOKEN;
    if (!token) throw new Error("Missing MESSENGER_PAGE_ACCESS_TOKEN");

    const pageId = process.env.MESSENGER_PAGE_ID ?? "1071930952666440";
    const graphVersion = process.env.META_GRAPH_VERSION ?? "v25.0";
    const limit = options.limit ?? Number(process.env.MESSENGER_SYNC_LIMIT ?? "5000");
    const messagesPerConversation = options.messagesPerConversation ?? Number(process.env.MESSENGER_SYNC_MESSAGES_PER_CONVERSATION ?? "50");

    const syncLog = await this.prisma.syncLog.create({
      data: {
        channel: Channel.messenger,
        syncType: "page_conversations_backfill",
        status: "running",
        metadata: { pageId, limit, messagesPerConversation },
      },
    });

    try {
      let url =
        `https://graph.facebook.com/${graphVersion}/${pageId}/conversations` +
        `?fields=id,updated_time,participants.limit(10){id,name,email}` +
        `&limit=100&access_token=${encodeURIComponent(token)}`;

      while (url && this.status.conversationsSeen < limit) {
        const page = await this.graph<GraphConversation>(url);
        for (const conversation of page.data ?? []) {
          if (this.status.conversationsSeen >= limit) break;
          this.status.conversationsSeen += 1;
          await this.importConversation(conversation, { pageId, graphVersion, token, messagesPerConversation }).catch((error) => {
            this.status.errors += 1;
            this.status.lastError = error instanceof Error ? error.message : String(error);
            console.error("Messenger conversation sync failed", conversation.id, error);
          });
        }
        url = page.paging?.next ?? "";
      }

      this.status.running = false;
      this.status.finishedAt = new Date().toISOString();
      await this.prisma.syncLog.update({
        where: { id: syncLog.id },
        data: {
          status: this.status.errors ? "completed_with_errors" : "completed",
          finishedAt: new Date(),
          importedMessagesCount: this.status.messagesImported,
          importedCustomersCount: this.status.customersEnsured,
          metadata: { ...this.status, pageId, limit, messagesPerConversation },
        },
      });
    } catch (error) {
      this.status.running = false;
      this.status.finishedAt = new Date().toISOString();
      await this.prisma.syncLog.update({
        where: { id: syncLog.id },
        data: {
          status: "failed",
          finishedAt: new Date(),
          errorMessage: error instanceof Error ? error.message : String(error),
          metadata: { ...this.status },
        },
      });
      throw error;
    }
  }

  private async importConversation(
    conversation: GraphConversation,
    config: { pageId: string; graphVersion: string; token: string; messagesPerConversation: number },
  ) {
    const customerParticipant = (conversation.participants?.data ?? []).find((participant) => participant.id !== config.pageId);
    if (!customerParticipant?.id) return;

    await this.ensureCustomerConversation(conversation, customerParticipant, config);

    let imported = 0;
    let url =
      `https://graph.facebook.com/${config.graphVersion}/${conversation.id}/messages` +
      `?fields=id,created_time,from,message,attachments.limit(10){id,name,size,mime_type,file_url,image_data,video_data}` +
      `&limit=25&access_token=${encodeURIComponent(config.token)}`;

    while (url && imported < config.messagesPerConversation) {
      const page = await this.graph<GraphMessage>(url);
      for (const message of page.data ?? []) {
        if (imported >= config.messagesPerConversation) break;
        imported += 1;
        if (message.from?.id !== customerParticipant.id) {
          this.status.messagesSkipped += 1;
          continue;
        }
        const existing = await this.prisma.message.findUnique({
          where: { channel_externalMessageId: { channel: Channel.messenger, externalMessageId: message.id } },
        });
        if (existing) {
          this.status.messagesSkipped += 1;
          continue;
        }
        const result = await this.ingest.ingestInbound(this.toInbound(message, conversation.id, customerParticipant, config));
        if (result.duplicate) this.status.messagesSkipped += 1;
        else this.status.messagesImported += 1;
      }
      url = page.paging?.next ?? "";
    }
  }

  private async ensureCustomerConversation(
    conversation: GraphConversation,
    participant: { id: string; name?: string; email?: string },
    config: { pageId: string; graphVersion: string; token: string },
  ) {
    const profile = await this.fetchProfile(participant.id, config).catch(() => undefined);
    const displayName = profile?.name ?? participant.name ?? "Facebook customer";
    const avatarUrl = profile?.profile_pic;
    const lastMessageAt = conversation.updated_time ? new Date(conversation.updated_time) : new Date();

    let identity = await this.prisma.customerIdentity.findUnique({
      where: { provider_externalId: { provider: "messenger", externalId: participant.id } },
      include: { customer: true },
    });

    if (!identity) {
      const customer = await this.prisma.customer.create({
        data: {
          displayName,
          primaryEmail: participant.email?.toLowerCase(),
          source: Channel.messenger,
          avatarUrl,
          lastMessageAt,
          lastContactAt: lastMessageAt,
          metadata: { messenger_psid: participant.id },
        },
      });
      identity = await this.prisma.customerIdentity.create({
        data: {
          customerId: customer.id,
          channel: Channel.messenger,
          provider: "messenger",
          externalId: participant.id,
          externalUserId: participant.id,
          email: participant.email?.toLowerCase(),
          displayName,
          avatarUrl,
          rawProfile: profile ?? participant,
          lastSeenAt: lastMessageAt,
        },
        include: { customer: true },
      });
    } else {
      await this.prisma.customer.update({
        where: { id: identity.customerId },
        data: {
          displayName: this.betterName(identity.customer.displayName, displayName),
          avatarUrl: identity.customer.avatarUrl ?? avatarUrl,
          lastMessageAt: this.maxDate(identity.customer.lastMessageAt, lastMessageAt),
          lastContactAt: this.maxDate(identity.customer.lastContactAt, lastMessageAt),
        },
      });
      await this.prisma.customerIdentity.update({
        where: { id: identity.id },
        data: {
          displayName: identity.displayName ?? displayName,
          avatarUrl: identity.avatarUrl ?? avatarUrl,
          rawProfile: profile ?? participant,
          lastSeenAt: lastMessageAt,
        },
      });
    }

    await this.prisma.conversation.upsert({
      where: { channel_externalThreadId: { channel: Channel.messenger, externalThreadId: participant.id } },
      update: {
        customerId: identity.customerId,
        identityId: identity.id,
        lastMessageAt,
      },
      create: {
        customerId: identity.customerId,
        identityId: identity.id,
        channel: Channel.messenger,
        externalThreadId: participant.id,
        status: "open",
        lastMessageAt,
        metadata: { graphConversationId: conversation.id, pageId: config.pageId },
      },
    });

    this.status.customersEnsured += 1;
  }

  private toInbound(
    message: GraphMessage,
    conversationId: string,
    participant: { id: string; name?: string; email?: string },
    config: { graphVersion: string; token: string; pageId: string },
  ): NormalizedInboundMessage {
    const attachments = this.normalizeAttachments(message.attachments?.data ?? []);
    const text = message.message ?? (attachments.length ? `[Messenger ${attachments[0].type}]` : "");
    return {
      channel: "messenger",
      provider: "messenger",
      channelAccountExternalId: config.pageId,
      externalThreadId: participant.id,
      externalMessageId: message.id,
      senderExternalId: participant.id,
      senderName: message.from?.name ?? participant.name,
      email: participant.email,
      text,
      timestamp: message.created_time,
      attachments,
      rawPayload: message,
    };
  }

  private normalizeAttachments(items: GraphAttachment[]): InboundAttachment[] {
    return items
      .map((item): InboundAttachment | null => {
        const url = item.image_data?.url ?? item.video_data?.url ?? item.file_url;
        if (!url) return null;
        return {
          type: this.mediaType(item.mime_type, url),
          url,
          mimeType: item.mime_type,
          fileName: item.name,
          sizeBytes: item.size,
          externalMediaId: item.id,
        };
      })
      .filter((item): item is InboundAttachment => Boolean(item));
  }

  private mediaType(mimeType?: string, url?: string): InboundAttachment["type"] {
    const probe = `${mimeType ?? ""} ${url ?? ""}`.toLowerCase();
    if (probe.includes("image") || /\.(png|jpe?g|gif|webp|heic)([?#/]|$)/.test(probe)) return "image";
    if (probe.includes("audio") || /\.(mp3|m4a|wav|ogg|opus|aac)([?#/]|$)/.test(probe)) return "audio";
    if (probe.includes("video") || /\.(mp4|mov|webm|avi)([?#/]|$)/.test(probe)) return "video";
    return "file";
  }

  private async fetchProfile(psid: string, config: { graphVersion: string; token: string }) {
    const url =
      `https://graph.facebook.com/${config.graphVersion}/${psid}` +
      `?fields=first_name,last_name,name,profile_pic&access_token=${encodeURIComponent(config.token)}`;
    const raw = await fetch(url).then((response) => response.json());
    if (raw.error) return undefined;
    return { name: raw.name ?? [raw.first_name, raw.last_name].filter(Boolean).join(" "), profile_pic: raw.profile_pic };
  }

  private async graph<T>(url: string): Promise<GraphPage<T>> {
    const response = await fetch(url);
    const json = (await response.json()) as GraphPage<T>;
    if (!response.ok || json.error) throw new Error(json.error?.message ?? response.statusText);
    return json;
  }

  private betterName(current?: string | null, incoming?: string) {
    if (!incoming) return current ?? undefined;
    if (!current || current === "New customer" || current === "Facebook customer" || current === "Facebook 用户") return incoming;
    return current;
  }

}
