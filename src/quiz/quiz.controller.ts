import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from "@nestjs/common";
import { QuizService } from "./quiz.service";
import {
  CreateQuizDto,
  UpdateQuizDto,
  AddQuestionsDto,
  ImageUploadUrlDto,
  ImportQuestionsDto,
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
   * Importer des questions depuis un fichier Markdown
   */
  @Post(":id/import")
  importQuestions(
    @Param("id") id: string,
    @Body() dto: ImportQuestionsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.quizService.importFromMarkdown(id, user.sub, dto);
  }
}
