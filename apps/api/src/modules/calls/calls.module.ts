import { Module } from "@nestjs/common";
import { InboxModule } from "../inbox/inbox.module";
import { CallsController } from "./calls.controller";
import { CallsService } from "./calls.service";
import { TwilioVoiceController } from "./twilio-voice.controller";

@Module({
  imports: [InboxModule],
  controllers: [CallsController, TwilioVoiceController],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
