import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { IngestService } from "./ingest.service";

@Module({
  imports: [AiModule],
  providers: [IngestService],
  exports: [IngestService],
})
export class InboxModule {}
