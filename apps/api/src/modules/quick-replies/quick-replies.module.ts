import { Module } from "@nestjs/common";
import { QuickRepliesController } from "./quick-replies.controller";

@Module({ controllers: [QuickRepliesController] })
export class QuickRepliesModule {}
