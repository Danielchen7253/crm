import { Module } from "@nestjs/common";
import { ChannelAccountsController } from "./channel-accounts.controller";
import { SettingsController } from "./settings.controller";
import { SyncLogsController } from "./sync-logs.controller";

@Module({ controllers: [SettingsController, ChannelAccountsController, SyncLogsController] })
export class SettingsModule {}
