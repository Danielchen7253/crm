import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("quick-replies")
export class QuickRepliesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.quickReply.findMany({ orderBy: [{ language: "asc" }, { name: "asc" }] });
  }

  @Post()
  create(@Body() body: any) {
    return this.prisma.quickReply.create({
      data: {
        name: body.name,
        channel: body.channel,
        language: body.language ?? "en",
        content: body.content,
      },
    });
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: any) {
    return this.prisma.quickReply.update({
      where: { id },
      data: {
        name: body.name,
        channel: body.channel,
        language: body.language,
        content: body.content,
        isActive: body.isActive,
      },
    });
  }
}
