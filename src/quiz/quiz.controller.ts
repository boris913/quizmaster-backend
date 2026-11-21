import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { QuizService, UploadedImportFile } from "./quiz.service";
import { Public } from "../common/decorators/public.decorator";
import { IMPORT_MAX_FILE_BYTES } from "./importers/import.types";
import {
  CreateQuizDto,
  UpdateQuizDto,
  AddQuestionsDto,
  ImageUploadUrlDto,
  ImportQuestionsDto,
  ImportQueryDto,
} from "./dto/quiz.dto";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import {
  CurrentUser,
  JwtPayload,
} from "../common/decorators/current-user.decorator";

@Controller("quizzes")
@UseGuards(JwtAuthGuard)
export class QuizController {
  constructor(private readonly quizService: QuizService) {}

  /**
   * GET /api/quizzes
   * Liste des quiz du créateur connecté
   */
  @Get()
  getMyQuizzes(@CurrentUser() user: JwtPayload) {
    return this.quizService.getMyQuizzes(user.sub);
  }

  /**
   * GET /api/quizzes/import-template.csv (public, issue #12)
   * Modèle CSV d'import : séparateur `;`, UTF-8 + BOM, un exemple par type.
   * Déclarée avant `:id` pour ne pas être capturée par cette route.
   */
  @Public()
  @Get("import-template.csv")
  getImportTemplate(@Res({ passthrough: true }) res: Response): string {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="kwizora-modele-import.csv"',
    );
    return this.quizService.getImportTemplateCsv();
  }

  /**
   * GET /api/quizzes/shared/:token (public, issue #12)
   * Aperçu d'un quiz partagé, sans bonnes réponses ni explications.
   */
  @Public()
  @Get("shared/:token")
  getSharedQuiz(@Param("token") token: string) {
    return this.quizService.getSharedQuiz(token);
  }

  /**
   * POST /api/quizzes/shared/:token/copy (issue #12)
   * Copie le quiz partagé dans le compte de l'utilisateur connecté.
   */
  @Post("shared/:token/copy")
  copySharedQuiz(
    @Param("token") token: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.quizService.copySharedQuiz(token, user.sub);
  }

  /**
   * GET /api/quizzes/:id
   * Détail d'un quiz avec ses questions
   */
  @Get(":id")
  getQuiz(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.quizService.getQuizById(id, user.sub);
  }

  /**
   * POST /api/quizzes
   * Créer un nouveau quiz (avec questions optionnelles)
   */
  @Post()
  createQuiz(@Body() dto: CreateQuizDto, @CurrentUser() user: JwtPayload) {
    return this.quizService.createQuiz(user.sub, dto);
  }

  /**
   * PATCH /api/quizzes/:id
   * Modifier un quiz
   */
  @Patch(":id")
  updateQuiz(
    @Param("id") id: string,
    @Body() dto: UpdateQuizDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.quizService.updateQuiz(id, user.sub, dto);
  }

  /**
   * DELETE /api/quizzes/:id
   * Supprimer un quiz
   */
  @Delete(":id")
  deleteQuiz(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.quizService.deleteQuiz(id, user.sub);
  }

  /**
   * POST /api/quizzes/:id/duplicate (issue #12)
   * Duplique un quiz du créateur (questions, ordre, images copiées).
   */
  @Post(":id/duplicate")
  duplicateQuiz(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.quizService.duplicateQuiz(id, user.sub);
  }

  /**
   * POST /api/quizzes/:id/share (issue #12)
   * Crée ou régénère le jeton de partage.
   */
  @Post(":id/share")
  createShareLink(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.quizService.createShareLink(id, user.sub);
  }

  /**
   * DELETE /api/quizzes/:id/share (issue #12)
   * Révoque le lien de partage.
   */
  @Delete(":id/share")
  revokeShareLink(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.quizService.revokeShareLink(id, user.sub);
  }

  /**
   * POST /api/quizzes/:id/questions
   * Ajouter des questions à un quiz
   */
  @Post(":id/questions")
  addQuestions(
    @Param("id") id: string,
    @Body() body: AddQuestionsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.quizService.addQuestions(id, user.sub, body.questions);
  }

  /**
   * POST /api/quizzes/:id/questions/image-upload-url (issue #7)
   * URL signée d'upload d'une image de question (bucket `question-images`).
   * Corps : { content_type: image/png|jpeg|webp|gif, size: octets ≤ 2 Mo }.
   */
  @Post(":id/questions/image-upload-url")
  createImageUploadUrl(
    @Param("id") id: string,
    @Body() dto: ImageUploadUrlDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.quizService.createImageUploadUrl(id, user.sub, dto);
  }

  /**
   * DELETE /api/quizzes/:quizId/questions/:questionId
   * Supprimer une question
   */
  @Delete(":quizId/questions/:questionId")
  deleteQuestion(
    @Param("quizId") quizId: string,
    @Param("questionId") questionId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.quizService.deleteQuestion(quizId, questionId, user.sub);
  }

  /**
   * POST /api/quizzes/:id/questions/reorder
   * Réordonner les questions
   */
  @Post(":id/questions/reorder")
  reorderQuestions(
    @Param("id") id: string,
    @Body() body: { ordered_ids: string[] },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.quizService.reorderQuestions(id, user.sub, body.ordered_ids);
  }

  /**
   * POST /api/quizzes/:id/import
   * - sans `format` : import Markdown historique (corps JSON
   *   `{ questions_content, answers_content? }`, réponse = questions créées) ;
   * - `?format=markdown|csv|xlsx|kahoot[&dryRun=true]` (issue #12) : fichier
   *   multipart (champ `file`, 2 Mo au plus) ou, pour markdown, le corps JSON ;
   *   réponse `{ format, dry_run, total_rows, valid, imported, questions,
   *   errors: [{ row, message }] }`.
   */
  @Post(":id/import")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: IMPORT_MAX_FILE_BYTES, files: 1, fields: 10 },
    }),
  )
  importQuestions(
    @Param("id") id: string,
    @Query() query: ImportQueryDto,
    @Body() dto: ImportQuestionsDto,
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file?: UploadedImportFile,
  ) {
    return this.quizService.importQuestions(id, user.sub, query, dto, file);
  }
}
