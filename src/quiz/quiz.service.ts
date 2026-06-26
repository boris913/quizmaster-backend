import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_CLIENT } from "../database/database.module";
import {
  CreateQuizDto,
  UpdateQuizDto,
  CreateQuestionDto,
  ImportQuestionsDto,
} from "./dto/quiz.dto";

@Injectable()
export class QuizService {
  constructor(@Inject(SUPABASE_CLIENT) private supabase: SupabaseClient) {}

  // ============================================================
  // QUIZ CRUD
  // ============================================================

  async createQuiz(creatorId: string, dto: CreateQuizDto) {
    const { questions, ...quizData } = dto;

    const { data: quiz, error } = await this.supabase
      .from("quizzes")
      .insert({ ...quizData, creator_id: creatorId })
      .select()
      .single();

    if (error) throw new Error(`Erreur création quiz: ${error.message}`);

    // Insérer les questions si fournies
    if (questions && questions.length > 0) {
      await this.addQuestions(quiz.id, creatorId, questions);
    }

    return this.getQuizById(quiz.id, creatorId);
  }

  async getQuizById(quizId: string, requesterId?: string) {
    const { data: quiz, error } = await this.supabase
      .from("quizzes")
      .select("*")
      .eq("id", quizId)
      .single();

    if (error || !quiz) throw new NotFoundException("Quiz introuvable");

    // Récupérer les questions
    const { data: questions } = await this.supabase
      .from("questions")
      .select("*")
      .eq("quiz_id", quizId)
      .order("order_index", { ascending: true });

    return { ...quiz, questions: questions || [] };
  }

  async getMyQuizzes(creatorId: string) {
    const { data, error } = await this.supabase
      .from("quizzes")
      .select(
        "id, title, description, total_questions, created_at, updated_at, global_timer_seconds, use_global_timer",
      )
      .eq("creator_id", creatorId)
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Erreur récupération quiz: ${error.message}`);
    return data || [];
  }

  async updateQuiz(quizId: string, creatorId: string, dto: UpdateQuizDto) {
    await this.assertOwnership(quizId, creatorId);

    const { data, error } = await this.supabase
      .from("quizzes")
      .update(dto)
      .eq("id", quizId)
      .select()
      .single();

    if (error) throw new Error(`Erreur mise à jour: ${error.message}`);
    return data;
  }

  async deleteQuiz(quizId: string, creatorId: string) {
    await this.assertOwnership(quizId, creatorId);

    const { error } = await this.supabase
      .from("quizzes")
      .delete()
      .eq("id", quizId);

    if (error) throw new Error(`Erreur suppression: ${error.message}`);
    return { message: "Quiz supprimé avec succès" };
  }

  // ============================================================
  // QUESTIONS
  // ============================================================

  async addQuestions(
    quizId: string,
    creatorId: string,
    questions: CreateQuestionDto[],
  ) {
    await this.assertOwnership(quizId, creatorId);

    // Récupérer l'index courant pour continuer la numérotation
    const { data: existing } = await this.supabase
      .from("questions")
      .select("order_index")
      .eq("quiz_id", quizId)
      .order("order_index", { ascending: false })
      .limit(1);

    const startIndex =
      existing && existing.length > 0 ? existing[0].order_index + 1 : 0;

    // Valider les bonnes réponses par rapport aux options
    for (const q of questions) {
      const optionIds = q.options.map((o) => o.id);
      for (const correctAnswer of q.correct_answers) {
        if (!optionIds.includes(correctAnswer)) {
          throw new BadRequestException(
            `La réponse correcte "${correctAnswer}" ne correspond à aucune option`,
          );
        }
      }
    }

    const questionsToInsert = questions.map((q, index) => ({
      quiz_id: quizId,
      text: q.text,
      type: q.type,
      options: q.options,
      correct_answers: q.correct_answers,
      max_points: q.max_points,
      timer_seconds: q.timer_seconds || 30,
      order_index: startIndex + index,
    }));

    const { data, error } = await this.supabase
      .from("questions")
      .insert(questionsToInsert)
      .select();

    if (error) throw new Error(`Erreur ajout questions: ${error.message}`);
    return data;
  }

  async deleteQuestion(quizId: string, questionId: string, creatorId: string) {
    await this.assertOwnership(quizId, creatorId);

    const { error } = await this.supabase
      .from("questions")
      .delete()
      .eq("id", questionId)
      .eq("quiz_id", quizId);

    if (error) throw new Error(`Erreur suppression question: ${error.message}`);
    return { message: "Question supprimée" };
  }

  async reorderQuestions(
    quizId: string,
    creatorId: string,
    orderedIds: string[],
  ) {
    await this.assertOwnership(quizId, creatorId);

    const updates = orderedIds.map((id, index) => ({
      id,
      order_index: index,
    }));

    for (const update of updates) {
      await this.supabase
        .from("questions")
        .update({ order_index: update.order_index })
        .eq("id", update.id)
        .eq("quiz_id", quizId);
    }

    return { message: "Questions réordonnées" };
  }

  // ============================================================
  // IMPORT DEPUIS FICHIER MARKDOWN
  // ============================================================

  async importFromMarkdown(
    quizId: string,
    creatorId: string,
    dto: ImportQuestionsDto,
  ) {
    await this.assertOwnership(quizId, creatorId);

    const questions = this.parseMarkdownQuestions(
      dto.questions_content,
      dto.answers_content,
    );

    if (questions.length === 0) {
      throw new BadRequestException("Aucune question trouvée dans le fichier");
    }

    return this.addQuestions(quizId, creatorId, questions);
  }

  /**
   * Parse le format Markdown défini dans le cahier des charges.
   *
   * Format Questions.md :
   * Quiz: Titre
   *
   * Question 1 [timer:30] [points:100]
   * A) Proposition A [correct]
   * B) Proposition B
   * C) Proposition C
   * D) Proposition D
   */
  private parseMarkdownQuestions(
    questionsContent: string,
    answersContent?: string,
  ): CreateQuestionDto[] {
    const lines = questionsContent.split("\n").map((l) => l.trim());
    const questions: CreateQuestionDto[] = [];

    let currentQuestion: Partial<CreateQuestionDto> | null = null;
    let currentOptions: Array<{ id: string; text: string }> = [];
    let currentCorrect: string[] = [];

    const saveCurrentQuestion = () => {
      if (currentQuestion && currentOptions.length >= 2) {
        questions.push({
          text: currentQuestion.text!,
          type: currentCorrect.length > 1 ? "multiple" : "single",
          options: currentOptions,
          correct_answers: currentCorrect,
          max_points: currentQuestion.max_points || 100,
          timer_seconds: currentQuestion.timer_seconds || 30,
        });
      }
    };

    for (const line of lines) {
      if (!line || line.startsWith("Quiz:")) continue;

      // Détection d'une nouvelle question: "Question N [timer:X] [points:Y]"
      const questionMatch = line.match(
        /^Question\s+\d+\s*(?:\[timer:(\d+)\])?\s*(?:\[points:(\d+)\])?/i,
      );
      if (questionMatch) {
        saveCurrentQuestion();
        currentQuestion = {
          timer_seconds: questionMatch[1] ? parseInt(questionMatch[1]) : 30,
          max_points: questionMatch[2] ? parseInt(questionMatch[2]) : 100,
        };
        currentOptions = [];
        currentCorrect = [];
        continue;
      }

      // Ligne de texte de question (après l'entête "Question N")
      if (currentQuestion && !currentQuestion.text && !line.match(/^[A-D]\)/)) {
        currentQuestion.text = line;
        continue;
      }

      // Option : "A) Texte [correct]"
      const optionMatch = line.match(/^([A-D])\)\s+(.+?)(?:\s+\[correct\])?$/);
      if (optionMatch && currentQuestion) {
        const optId = optionMatch[1];
        const optText = optionMatch[2].replace(/\s*\[correct\]\s*$/, "");
        currentOptions.push({ id: optId, text: optText });

        if (line.includes("[correct]")) {
          currentCorrect.push(optId);
        }
      }
    }

    // Sauvegarder la dernière question
    saveCurrentQuestion();

    // Si un fichier de réponses séparé est fourni, l'appliquer
    if (answersContent) {
      this.applyAnswersFile(questions, answersContent);
    }

    return questions;
  }

  /**
   * Format reponses.md :
   * ## Question 1
   * C
   *
   * ## Question 2
   * A,B
   */
  private applyAnswersFile(
    questions: CreateQuestionDto[],
    answersContent: string,
  ) {
    const sections = answersContent.split(/##\s+Question\s+/i).slice(1);

    sections.forEach((section, index) => {
      if (index >= questions.length) return;
      const lines = section
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length < 2) return;

      const answers = lines[1].split(",").map((a) => a.trim().toUpperCase());
      questions[index].correct_answers = answers;
      questions[index].type = answers.length > 1 ? "multiple" : "single";
    });
  }

  // ============================================================
  // HELPER
  // ============================================================

  private async assertOwnership(quizId: string, creatorId: string) {
    const { data: quiz } = await this.supabase
      .from("quizzes")
      .select("creator_id")
      .eq("id", quizId)
      .single();

    if (!quiz) throw new NotFoundException("Quiz introuvable");
    if (quiz.creator_id !== creatorId) {
      throw new ForbiddenException("Vous n'êtes pas le créateur de ce quiz");
    }
  }
}
