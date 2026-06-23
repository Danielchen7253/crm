import { Module } from "@nestjs/common";
import { InboxModule } from "../inbox/inbox.module";
import { LegacyMigrationController } from "./legacy-migration.controller";
import { MessengerSyncController } from "./messenger-sync.controller";
import { MessengerSyncService } from "./messenger-sync.service";

@Module({
  imports: [InboxModule],
  controllers: [LegacyMigrationController, MessengerSyncController],
  providers: [MessengerSyncService],
})
export class AdminModule {}
