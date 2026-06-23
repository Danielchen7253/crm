import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { TagsModule } from "../tags/tags.module";
import { IngestService } from "./ingest.service";

@Module({
  imports: [AiModule, RealtimeModule, TagsModule],
  providers: [IngestService],
  exports: [IngestService],
})
export class InboxModule {}
