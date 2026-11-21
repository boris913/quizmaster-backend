import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import {
  CurrentUser,
  JwtPayload,
} from "../common/decorators/current-user.decorator";
import { AiService, UploadedPdf } from "./ai.service";
import { GenerateQuizDto } from "./dto/generate-quiz.dto";
import { AI_FIELD_MAX_BYTES, AI_PDF_MAX_BYTES } from "./ai.constants";

/**
 * Génération de quiz par IA (issue #11). Authentification requise : le
 * garde JWT s'exécute avant la lecture du corps multipart.
 */
@Controller("quizzes/generate")
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly aiService: AiService) {}

  /**
   * POST /api/quizzes/generate (multipart/form-data)
   * Champs : text? | file? (PDF ≤ 10 Mo), level, count (1-30), types[]?.
   * Renvoie un brouillon de questions, sans rien enregistrer.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor("file", {
      limits: {
        fileSize: AI_PDF_MAX_BYTES,
        files: 1,
        fieldSize: AI_FIELD_MAX_BYTES,
      },
    }),
  )
  generate(
    @Body() dto: GenerateQuizDto,
    @UploadedFile() file: UploadedPdf | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.aiService.generate(user.sub, dto, file);
  }

  /** GET /api/quizzes/generate/quota — état du quota mensuel de l'utilisateur. */
  @Get("quota")
  getQuota(@CurrentUser() user: JwtPayload) {
    return this.aiService.getQuota(user.sub);
  }
}
