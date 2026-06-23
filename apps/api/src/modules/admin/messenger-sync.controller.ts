import { Body, Controller, Get, Post } from "@nestjs/common";
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
  repairConversations() {
    return this.messengerSync.repairMessengerConversations();
  }
}
