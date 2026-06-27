import { Module } from "@nestjs/common";
import { ChannelAccountsBootstrapService } from "./channel-accounts-bootstrap.service";
import { ChannelAccountsController } from "./channel-accounts.controller";
import { SettingsController } from "./settings.controller";
import { SyncLogsController } from "./sync-logs.controller";

@Module({
  controllers: [SettingsController, ChannelAccountsController, SyncLogsController],
  providers: [ChannelAccountsBootstrapService],
})
export class SettingsModule {}
