import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppController } from "./app.controller";
import { AdminModule } from "./modules/admin/admin.module";
import { AiModule } from "./modules/ai/ai.module";
import { AuthModule } from "./modules/auth/auth.module";
import { CallsModule } from "./modules/calls/calls.module";
import { CampaignsModule } from "./modules/campaigns/campaigns.module";
import { ConversationsModule } from "./modules/conversations/conversations.module";
import { CustomersModule } from "./modules/customers/customers.module";
import { FilesModule } from "./modules/files/files.module";
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
    FilesModule,
    WebhooksModule,
    AiModule,
    CampaignsModule,
    QuickRepliesModule,
    SettingsModule,
    AdminModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
