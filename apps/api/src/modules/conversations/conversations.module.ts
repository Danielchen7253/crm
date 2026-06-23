import { Module } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module";
import { ConversationsController } from "./conversations.controller";

@Module({ imports: [RealtimeModule], controllers: [ConversationsController] })
export class ConversationsModule {}
