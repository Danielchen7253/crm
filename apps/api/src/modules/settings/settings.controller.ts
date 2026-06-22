import { Body, Controller, Get, Patch, Query } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("settings")
export class SettingsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Query("namespace") namespace?: string) {
    return this.prisma.setting.findMany({
      where: { namespace },
      orderBy: [{ namespace: "asc" }, { key: "asc" }],
    });
  }

  @Patch()
  upsert(@Body() body: { namespace: string; key: string; value: unknown; sensitive?: boolean }) {
    return this.prisma.setting.upsert({
      where: { namespace_key: { namespace: body.namespace, key: body.key } },
      update: { value: body.value as object, sensitive: body.sensitive },
      create: {
        namespace: body.namespace,
        key: body.key,
        value: body.value as object,
        sensitive: body.sensitive ?? false,
      },
    });
  }
}
