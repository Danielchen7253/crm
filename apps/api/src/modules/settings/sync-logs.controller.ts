import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { Channel } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Controller("sync-logs")
export class SyncLogsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Query("channel") channel?: Channel, @Query("channelAccountId") channelAccountId?: string) {
    return this.prisma.syncLog.findMany({
      where: { channel, channelAccountId },
      orderBy: { startedAt: "desc" },
      take: 100,
    });
  }

  @Post()
  create(@Body() body: any) {
    return this.prisma.syncLog.create({
      data: {
        channel: body.channel,
        channelAccountId: body.channelAccountId,
        syncType: body.syncType ?? "manual",
        status: body.status ?? "running",
        metadata: body.metadata ?? {},
      },
    });
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: any) {
    return this.prisma.syncLog.update({
      where: { id },
      data: {
        finishedAt: body.finishedAt ? new Date(body.finishedAt) : body.status && body.status !== "running" ? new Date() : undefined,
        status: body.status,
        importedMessagesCount: body.importedMessagesCount,
        importedCustomersCount: body.importedCustomersCount,
        errorMessage: body.errorMessage,
        metadata: body.metadata,
      },
    });
  }
}
