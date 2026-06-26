import { Module } from "@nestjs/common";
import { CallsModule } from "../calls/calls.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { ChannelSenderService } from "./channel-sender.service";
import { MessagesController } from "./messages.controller";

@Module({ imports: [RealtimeModule, CallsModule], controllers: [MessagesController], providers: [ChannelSenderService] })
export class MessagesModule {}
