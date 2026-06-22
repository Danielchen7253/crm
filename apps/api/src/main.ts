import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { CallsService } from "./modules/calls/calls.service";
import { attachTwilioMediaStream } from "./modules/realtime/twilio-media-stream";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.WEB_ORIGIN?.split(",") ?? true,
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix("api");
  const adapter = app.getHttpAdapter();
  const statusPayload = {
    name: "CoolFix Omni CRM API",
    status: "ok",
    docs: {
      health: "/api/auth/me",
      conversations: "/api/conversations",
      twilioIncoming: "/api/twilio/incoming",
    },
  };
  adapter.get("/", (_req, res) => res.json(statusPayload));
  adapter.get("/api", (_req, res) => res.json(statusPayload));
  attachTwilioMediaStream(app.getHttpServer(), app.get(CallsService));
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 4000);
}

void bootstrap();
