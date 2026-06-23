import { Module } from "@nestjs/common";
import { InboxModule } from "../inbox/inbox.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { WebhooksController } from "./webhooks.controller";

@Module({
  imports: [InboxModule, RealtimeModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
