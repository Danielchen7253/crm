import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { SchemaBootstrapService } from "./schema-bootstrap.service";

@Global()
@Module({
  providers: [PrismaService, SchemaBootstrapService],
  exports: [PrismaService],
})
export class PrismaModule {}
