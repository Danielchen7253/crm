import { Body, Controller, Get, Post } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly prisma: PrismaService) {}

  @Post("login")
  login(@Body() body: { email: string }) {
    return {
      accessToken: "development-token",
      user: { email: body.email, name: body.email },
      note: "Replace with JWT password login before production.",
    };
  }

  @Post("logout")
  logout() {
    return { ok: true };
  }

  @Get("me")
  async me() {
    const admin = await this.prisma.user.findFirst({ include: { roles: { include: { role: true } } } });
    return admin ?? { email: "admin@coolfixpro.com", name: "Admin", roles: ["Admin"] };
  }
}
