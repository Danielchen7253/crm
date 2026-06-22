import { Module } from "@nestjs/common";
import { InboxModule } from "../inbox/inbox.module";
import { WebhooksController } from "./webhooks.controller";

@Module({
  imports: [InboxModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
