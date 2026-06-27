import { Body, Controller, Get, Post } from "@nestjs/common";
import { Channel } from "@prisma/client";
import { MessengerSyncService } from "./messenger-sync.service";

@Controller("admin/messenger")
export class MessengerSyncController {
  constructor(private readonly messengerSync: MessengerSyncService) {}

  @Post("sync")
  start(@Body() body: { limit?: number; messagesPerConversation?: number } = {}) {
    return this.messengerSync.start({
      limit: body.limit,
      messagesPerConversation: body.messagesPerConversation,
    });
  }

  @Get("sync/status")
  status() {
    return this.messengerSync.getStatus();
  }

  @Post("repair-conversations")
  repairConversations(@Body() body: { channels?: Array<"messenger" | "instagram" | "whatsapp"> } = {}) {
    return this.messengerSync.repairMetaConversations(
      !body.channels?.length
        ? [Channel.messenger, Channel.instagram, Channel.whatsapp]
        : body.channels.map((channel) =>
            channel === "instagram" ? Channel.instagram : channel === "whatsapp" ? Channel.whatsapp : Channel.messenger,
          ),
    );
  }

  @Post("cleanup-test-record")
  cleanupTestRecord(@Body() body: { psid?: string } = {}) {
    return this.messengerSync.cleanupTestRecord(body.psid);
  }
}
