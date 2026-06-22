import { Module } from "@nestjs/common";
import { ChannelAccountsController } from "./channel-accounts.controller";
import { SettingsController } from "./settings.controller";

@Module({ controllers: [SettingsController, ChannelAccountsController] })
export class SettingsModule {}
