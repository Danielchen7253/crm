import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AiModule } from "./modules/ai/ai.module";
import { AuthModule } from "./modules/auth/auth.module";
import { CallsModule } from "./modules/calls/calls.module";
import { CampaignsModule } from "./modules/campaigns/campaigns.module";
import { ConversationsModule } from "./modules/conversations/conversations.module";
import { CustomersModule } from "./modules/customers/customers.module";
import { InboxModule } from "./modules/inbox/inbox.module";
import { MessagesModule } from "./modules/messages/messages.module";
import { PrismaModule } from "./modules/prisma/prisma.module";
import { QuickRepliesModule } from "./modules/quick-replies/quick-replies.module";
import { RealtimeModule } from "./modules/realtime/realtime.module";
import { SettingsModule } from "./modules/settings/settings.module";
import { WebhooksModule } from "./modules/webhooks/webhooks.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RealtimeModule,
    AuthModule,
    CallsModule,
    InboxModule,
    ConversationsModule,
    MessagesModule,
    CustomersModule,
    WebhooksModule,
    AiModule,
    CampaignsModule,
    QuickRepliesModule,
    SettingsModule,
  ],
})
export class AppModule {}
