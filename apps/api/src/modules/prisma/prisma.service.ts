import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    // Prisma connects lazily on the first query. Avoid failing the whole API
    // process during deploy if the database needs a moment to accept traffic.
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
