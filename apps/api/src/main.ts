import { RequestMethod, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { json, urlencoded } from "express";
import { AppModule } from "./app.module";
import { CallsService } from "./modules/calls/calls.service";
import { attachTwilioMediaStream } from "./modules/realtime/twilio-media-stream";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(json({ limit: "10mb" }));
  app.use(urlencoded({ extended: true }));

  const baseOrigins = new Set((process.env.WEB_ORIGIN?.split(",") ?? []).map((origin) => origin.trim()).filter(Boolean));
  const websiteChatOrigins = new Set((process.env.WEBSITE_CHAT_ALLOWED_ORIGINS?.split(",") ?? []).map((origin) => origin.trim()).filter(Boolean));
  const mergedOrigins = Array.from(new Set([...Array.from(baseOrigins), ...Array.from(websiteChatOrigins)]));
  const wildcardCors = process.env.CORS_ALLOW_ALL_ORIGINS === "1";
  const corsOrigin = wildcardCors ? true : (mergedOrigins.length ? mergedOrigins : true);

  app.enableCors({
    origin: corsOrigin,
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix("api", {
    exclude: [{ path: "/", method: RequestMethod.GET }],
  });
  const server = app.getHttpAdapter().getInstance();
  server.use((request: any, _response: any, next: () => void) => {
    const path = ((request.path || "").toString().toLowerCase() || "/").replace(/\/+$/, "").replace(/^$/, "/");
    const isWebhookRoot = path === "/";
    const isWebhookAlias = path === "/webhooks" || path.startsWith("/webhooks/");

    if (!isWebhookRoot && !isWebhookAlias) return next();

    if (request.method === "GET") {
      const hasMetaChallenge =
        request.query?.["hub.mode"] === "subscribe" &&
        (request.query?.["hub.verify_token"] || request.query?.["hub.challenge"]);
      if (hasMetaChallenge) {
        request.url = path === "/" ? "/api/webhooks" : `/api${path.replace(/^\/webhooks/, "/webhooks")}`;
      }
      return next();
    }

    if (request.method === "POST") {
      request.url = path === "/" ? "/api/webhooks" : `/api${path.replace(/^\/webhooks/, "/webhooks")}`;
      return next();
    }

    return next();
  });
  attachTwilioMediaStream(app.getHttpServer(), app.get(CallsService));
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 4000);
}

void bootstrap();
