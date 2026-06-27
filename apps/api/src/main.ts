import { RequestMethod, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { CallsService } from "./modules/calls/calls.service";
import { attachTwilioMediaStream } from "./modules/realtime/twilio-media-stream";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
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
    exclude: [
      { path: "/", method: RequestMethod.GET },
      { path: "messenger", method: RequestMethod.ALL },
      { path: "/messenger", method: RequestMethod.ALL },
    ],
  });
  const server = app.getHttpAdapter().getInstance();
  server.use("/messenger", (request: any, _response: any, next: () => void) => {
    const suffix = (request.url ?? "").toString().replace(/^\/messenger/i, "");
    request.url = `/api/webhooks/messenger${suffix}`;
    return next();
  });

  const readQueryValue = (query: Record<string, unknown> | undefined, name: string): string | undefined => {
    const direct = query?.[name];
    if (typeof direct === "string") return direct;
    if (!query) return undefined;
    const parts = name.split(".");
    let current: unknown = query;
    for (const part of parts) {
      if (typeof current !== "object" || current === null) return undefined;
      const next = (current as Record<string, unknown>)?.[part];
      if (next === undefined || next === null) return undefined;
      if (typeof next === "string" || typeof next === "number") return String(next);
      current = next;
    }
    return undefined;
  };

  const webhookAliases = new Set([
    "/messenger",
    "/webhooks",
    "/whatsapp",
    "/instagram",
    "/meta",
    "/website-chat",
    "/website_chat",
    "/twilio",
    "/twilio/incoming",
    "/twilio/sms",
    "/twilio/status",
    "/twilio/whatsapp",
  ]);
  const normalizeWebhookPath = (path: string) => {
    const normalized = path.toLowerCase().replace(/\/+$/, "").replace(/^$/, "/");
    if (normalized === "/") return "/";
    if (normalized === "/webhooks" || normalized.startsWith("/webhooks/")) return normalized;
    if (normalized === "/twilio" || normalized.startsWith("/twilio/")) return `/api/webhooks${normalized}`;
    for (const alias of webhookAliases) {
      if (normalized === alias || normalized.startsWith(`${alias}/`)) {
        return `/api/webhooks${normalized}`;
      }
    }
    return normalized;
  };

  server.use((request: any, _response: any, next: () => void) => {
    const normalizedPath = normalizeWebhookPath(((request.path || "").toString()).toLowerCase());
    const isWebhookRoot = normalizedPath === "/";
    const isWebhookAlias = webhookAliases.has(normalizedPath) || normalizedPath === "/webhooks" || normalizedPath.startsWith("/webhooks/");

    if (!isWebhookRoot && !isWebhookAlias) return next();

    const mappedPath = (() => {
      if (isWebhookRoot) return "/api/webhooks";
      if (normalizedPath.startsWith("/webhooks")) return `/api${normalizedPath.replace(/^\/webhooks/, "/webhooks")}`;
      return `/api/webhooks${normalizedPath}`;
    })();

    if (request.method === "GET") {
      const hubMode = readQueryValue(request.query, "hub.mode");
      const verifyToken = readQueryValue(request.query, "hub.verify_token");
      const challenge = readQueryValue(request.query, "hub.challenge");
      const hasMetaChallenge =
        hubMode === "subscribe" &&
        (verifyToken || challenge);
      if (hasMetaChallenge) {
        request.url = mappedPath;
      }
      return next();
    }

    if (request.method === "POST") {
      request.url = mappedPath;
      return next();
    }

    return next();
  });
  attachTwilioMediaStream(app.getHttpServer(), app.get(CallsService));
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 4000);
}

void bootstrap();
