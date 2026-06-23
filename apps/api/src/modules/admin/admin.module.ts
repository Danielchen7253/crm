import { Module } from "@nestjs/common";
import { LegacyMigrationController } from "./legacy-migration.controller";

@Module({
  controllers: [LegacyMigrationController],
})
export class AdminModule {}
