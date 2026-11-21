import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { GLOBAL_VALIDATION_OPTIONS } from "./common/validation";
import {
  corsOriginCallback,
  getAllowedOrigins,
  isUsingDefaultOrigins,
} from "./common/utils/cors.util";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // CORS : origines autorisées via CORS_ORIGINS (voir common/utils/cors.util.ts)
  const logger = new Logger("Bootstrap");
  if (isUsingDefaultOrigins()) {
    const msg =
      "CORS_ORIGINS non défini : seule l'origine de développement http://localhost:3000 est autorisée.";
    if (process.env.NODE_ENV === "production") logger.warn(msg);
    else logger.log(msg);
  } else {
    logger.log(`CORS autorisé pour : ${getAllowedOrigins().join(", ")}`);
  }
  app.enableCors({
    origin: corsOriginCallback,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // X-Resume-Token : jeton de reprise des devoirs (issue #10)
    allowedHeaders: ["Content-Type", "Authorization", "X-Resume-Token"],
  });

  // Validation globale des DTOs
  app.useGlobalPipes(new ValidationPipe(GLOBAL_VALIDATION_OPTIONS));

  // Prefix global API
  app.setGlobalPrefix("api");

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`🚀 Kwizora Backend running on: http://localhost:${port}`);
  console.log(`🔌 WebSocket ready on: ws://localhost:${port}`);
}
bootstrap();
