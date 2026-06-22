import { Module } from "@nestjs/common";
import { CallsController } from "./calls.controller";
import { CallsService } from "./calls.service";
import { TwilioVoiceController } from "./twilio-voice.controller";

@Module({
  controllers: [CallsController, TwilioVoiceController],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
