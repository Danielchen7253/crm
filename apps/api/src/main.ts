import { RequestMethod, ValidationPipe } from "@nestjs/common";
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
  app.setGlobalPrefix("api", {
    exclude: [{ path: "/", method: RequestMethod.GET }],
  });
  attachTwilioMediaStream(app.getHttpServer(), app.get(CallsService));
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 4000);
}

void bootstrap();
