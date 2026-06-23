import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

@Injectable()
export class SchemaBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(SchemaBootstrapService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    const statements = [
      `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
      `ALTER TABLE "CustomerIdentity" ADD COLUMN IF NOT EXISTS "externalUserId" TEXT`,
      `ALTER TABLE "CustomerIdentity" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3)`,
      `CREATE INDEX IF NOT EXISTS "CustomerIdentity_channel_externalUserId_idx" ON "CustomerIdentity"("channel", "externalUserId")`,
      `ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "channelAccountId" UUID`,
      `ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "externalConversationId" TEXT`,
      `ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "senderType" TEXT`,
      `ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "contentType" "MessageType" NOT NULL DEFAULT 'text'`,
      `ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "textContent" TEXT`,
      `ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "providerErrorCode" TEXT`,
      `ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "providerErrorMessage" TEXT`,
      `ALTER TABLE "MessageAttachment" ADD COLUMN IF NOT EXISTS "fileUrl" TEXT`,
      `ALTER TABLE "MessageAttachment" ADD COLUMN IF NOT EXISTS "externalMediaId" TEXT`,
      `ALTER TABLE "WebhookEvent" ADD COLUMN IF NOT EXISTS "eventType" TEXT`,
      `ALTER TABLE "WebhookEvent" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'received'`,
      `ALTER TABLE "WebhookEvent" ADD COLUMN IF NOT EXISTS "errorMessage" TEXT`,
      `CREATE TABLE IF NOT EXISTS "SyncLog" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "channel" "Channel" NOT NULL,
        "channelAccountId" UUID,
        "syncType" TEXT NOT NULL,
        "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "finishedAt" TIMESTAMP(3),
        "status" TEXT NOT NULL DEFAULT 'running',
        "importedMessagesCount" INTEGER NOT NULL DEFAULT 0,
        "importedCustomersCount" INTEGER NOT NULL DEFAULT 0,
        "errorMessage" TEXT,
        "metadata" JSONB NOT NULL DEFAULT '{}',
        CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
      )`,
      `CREATE INDEX IF NOT EXISTS "SyncLog_channel_status_idx" ON "SyncLog"("channel", "status")`,
      `CREATE INDEX IF NOT EXISTS "SyncLog_channelAccountId_startedAt_idx" ON "SyncLog"("channelAccountId", "startedAt")`,
      `ALTER TABLE "Tag" ADD COLUMN IF NOT EXISTS "group_name" TEXT`,
      `ALTER TABLE "Tag" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true`,
      `CREATE INDEX IF NOT EXISTS "Tag_groupName_isActive_idx" ON "Tag"("group_name", "is_active")`,
      `ALTER TABLE "CustomerTag" ADD COLUMN IF NOT EXISTS "id" UUID NOT NULL DEFAULT gen_random_uuid()`,
      `ALTER TABLE "CustomerTag" ADD COLUMN IF NOT EXISTS "created_by" UUID`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "CustomerTag_id_key" ON "CustomerTag"("id")`,
      `CREATE INDEX IF NOT EXISTS "CustomerTag_tagId_createdAt_idx" ON "CustomerTag"("tagId", "createdAt")`,
      `CREATE INDEX IF NOT EXISTS "CustomerTag_createdBy_idx" ON "CustomerTag"("created_by")`,
    ];

    for (const statement of statements) {
      await this.prisma.$executeRawUnsafe(statement);
    }
    this.logger.log("CRM omnichannel schema bootstrap complete");
  }
}
