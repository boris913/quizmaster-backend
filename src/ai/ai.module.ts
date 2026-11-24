import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";
import { AiQuotaService } from "./ai-quota.service";
import { PdfTextExtractor } from "./pdf-text";
import { geminiClientProvider } from "./gemini-client.provider";

/** Génération de quiz par IA depuis un texte ou un PDF de cours (issue #11). */
@Module({
  imports: [AuthModule],
  controllers: [AiController],
  providers: [
    AiService,
    AiQuotaService,
    PdfTextExtractor,
    geminiClientProvider,
  ],
})
export class AiModule {}
