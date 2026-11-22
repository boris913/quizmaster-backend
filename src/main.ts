import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";
import {
  getAllowedOrigins,
  isUsingDefaultOrigins,
} from "./common/utils/cors.util";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const logger = new Logger("Bootstrap");
  if (isUsingDefaultOrigins()) {
    const msg =
      "CORS_ORIGINS non défini : seule l'origine de développement http://localhost:3000 est autorisée.";
    if (process.env.NODE_ENV === "production") logger.warn(msg);
    else logger.log(msg);
  } else {
    logger.log(`CORS autorisé pour : ${getAllowedOrigins().join(", ")}`);
  }

  configureApp(app);

  // 0.0.0.0 : joignable depuis le proxy dans un conteneur Docker
  const port = Number(process.env.PORT) || 3001;
  await app.listen(port, "0.0.0.0");
  console.log(`🚀 Kwizora Backend running on: http://localhost:${port}`);
  console.log(`🔌 WebSocket ready on: ws://localhost:${port}`);
}
bootstrap();
