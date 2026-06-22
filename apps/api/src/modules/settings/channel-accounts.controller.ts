import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("channel-accounts")
export class ChannelAccountsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.channelAccount.findMany({
      select: {
        id: true,
        channel: true,
        name: true,
        providerAccountId: true,
        externalPageId: true,
        fromAddress: true,
        settings: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ channel: "asc" }, { name: "asc" }],
    });
  }

  @Post()
  create(@Body() body: any) {
    return this.prisma.channelAccount.create({
      data: {
        channel: body.channel,
        name: body.name,
        providerAccountId: body.providerAccountId,
        externalPageId: body.externalPageId,
        fromAddress: body.fromAddress,
        encryptedToken: body.encryptedToken,
        encryptedSecret: body.encryptedSecret,
        settings: body.settings ?? {},
      },
    });
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: any) {
    return this.prisma.channelAccount.update({
      where: { id },
      data: {
        name: body.name,
        providerAccountId: body.providerAccountId,
        externalPageId: body.externalPageId,
        fromAddress: body.fromAddress,
        encryptedToken: body.encryptedToken,
        encryptedSecret: body.encryptedSecret,
        settings: body.settings,
        isActive: body.isActive,
      },
    });
  }
}
