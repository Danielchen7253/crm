import { Module } from "@nestjs/common";
import { CallsModule } from "../calls/calls.module";
import { InboxModule } from "../inbox/inbox.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { MessengerCompatController } from "./messenger-compat.controller";
import { WebhooksController } from "./webhooks.controller";
import { TwilioLegacyController } from "./twilio-legacy.controller";

@Module({
  imports: [InboxModule, RealtimeModule, CallsModule],
  controllers: [WebhooksController, TwilioLegacyController, MessengerCompatController],
})
export class WebhooksModule {}
