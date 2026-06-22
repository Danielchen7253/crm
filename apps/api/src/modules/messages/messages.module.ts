import { Module } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module";
import { MessagesController } from "./messages.controller";

@Module({ imports: [RealtimeModule], controllers: [MessagesController] })
export class MessagesModule {}
