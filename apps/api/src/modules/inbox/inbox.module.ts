import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { IngestService } from "./ingest.service";

@Module({
  imports: [AiModule, RealtimeModule],
  providers: [IngestService],
  exports: [IngestService],
})
export class InboxModule {}
