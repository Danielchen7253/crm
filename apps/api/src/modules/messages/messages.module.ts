import { Module } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module";
import { ChannelSenderService } from "./channel-sender.service";
import { MessagesController } from "./messages.controller";

@Module({ imports: [RealtimeModule], controllers: [MessagesController], providers: [ChannelSenderService] })
export class MessagesModule {}
