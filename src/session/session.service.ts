import {
  Injectable,
  Inject,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/database.module';
import { CreateSessionDto, JoinSessionDto } from './dto/session.dto';
import { generateSessionPassword } from '../common/utils/scoring.util';

@Injectable()
export class SessionService {
  constructor(@Inject(SUPABASE_CLIENT) private supabase: SupabaseClient) {}

  // ============================================================
  // CRÉATION & GESTION DE SESSION (CRÉATEUR)
  // ============================================================

  async createSession(creatorId: string, dto: CreateSessionDto) {
    // Vérifier que le quiz appartient au créateur
    const { data: quiz } = await this.supabase
      .from('quizzes')
      .select('id, creator_id, total_questions, title')
      .eq('id', dto.quiz_id)
      .single();

    if (!quiz) throw new NotFoundException('Quiz introuvable');
    if (quiz.creator_id !== creatorId) {
      throw new ForbiddenException("Vous n'êtes pas le créateur de ce quiz");
    }
    if (quiz.total_questions === 0) {
      throw new BadRequestException('Le quiz doit avoir au moins une question');
    }

    // Générer un mot de passe unique
    let password: string;
    let attempts = 0;
    do {
      password = generateSessionPassword();
      const { data: existing } = await this.supabase
        .from('sessions')
        .select('id')
        .eq('password', password)
        .eq('status', 'waiting')
        .single();
      if (!existing) break;
      attempts++;
    } while (attempts < 10);

    const { data: session, error } = await this.supabase
      .from('sessions')
      .insert({
        quiz_id: dto.quiz_id,
        creator_id: creatorId,
        password,
        status: 'waiting',
        current_question_index: -1,
      })
      .select()
      .single();

    if (error) throw new Error(`Erreur création session: ${error.message}`);

    return { ...session, quiz_title: quiz.title, total_questions: quiz.total_questions };
  }

  async getSessionByCreator(sessionId: string, creatorId: string) {
    const session = await this.getSessionWithDetails(sessionId);

    if (session.creator_id !== creatorId) {
      throw new ForbiddenException('Accès refusé');
    }

    return session;
  }

  async getCreatorSessions(creatorId: string) {
    const { data, error } = await this.supabase
      .from('sessions')
      .select(`
        id, password, status, current_question_index, created_at, started_at, ended_at,
        quizzes (id, title, total_questions)
      `)
      .eq('creator_id', creatorId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(`Erreur: ${error.message}`);
    return data || [];
  }

  async endSession(sessionId: string, creatorId: string) {
    await this.assertCreatorSession(sessionId, creatorId);

    const { data, error } = await this.supabase
      .from('sessions')
      .update({ status: 'finished', ended_at: new Date().toISOString() })
      .eq('id', sessionId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  // ============================================================
  // REJOINDRE UNE SESSION (PARTICIPANT)
  // ============================================================

  async joinSession(dto: JoinSessionDto) {
    // Chercher la session par mot de passe
    const { data: session, error: sessionError } = await this.supabase
      .from('sessions')
      .select('id, status, quiz_id, quizzes(title, total_questions)')
      .eq('password', dto.password.toUpperCase())
      .in('status', ['waiting', 'active', 'paused'])
      .single();

    if (sessionError || !session) {
      throw new NotFoundException(
        'Session introuvable ou terminée. Vérifiez le mot de passe.',
      );
    }

    // Vérifier unicité du pseudo dans cette session
    const { data: existingParticipant } = await this.supabase
      .from('participants')
      .select('id, status')
      .eq('session_id', session.id)
      .eq('pseudo', dto.pseudo)
      .single();

    if (existingParticipant && existingParticipant.status !== 'disconnected') {
      throw new ConflictException('Ce pseudo est déjà utilisé dans cette session');
    }

    // Si le participant existait (déconnecté), le réactiver
    if (existingParticipant) {
      const { data: updated } = await this.supabase
        .from('participants')
        .update({ status: 'waiting' })
        .eq('id', existingParticipant.id)
        .select()
        .single();
      return { participant: updated, session };
    }

    // Créer un nouveau participant
    const { data: participant, error: partError } = await this.supabase
      .from('participants')
      .insert({
        session_id: session.id,
        pseudo: dto.pseudo,
        score: 0,
        status: 'waiting',
      })
      .select()
      .single();

    if (partError) throw new Error(`Erreur: ${partError.message}`);

    return { participant, session };
  }

  // ============================================================
  // ACCÈS AUX DONNÉES DE SESSION
  // ============================================================

  async getSessionWithDetails(sessionId: string) {
    const { data: session, error } = await this.supabase
      .from('sessions')
      .select(`
        *,
        quizzes (id, title, description, total_questions, global_timer_seconds, use_global_timer)
      `)
      .eq('id', sessionId)
      .single();

    if (error || !session) throw new NotFoundException('Session introuvable');
    return session;
  }

  async getSessionParticipants(sessionId: string) {
    const { data, error } = await this.supabase
      .from('participants')
      .select('id, pseudo, score, status, joined_at')
      .eq('session_id', sessionId)
      .neq('status', 'disconnected')
      .order('score', { ascending: false });

    if (error) throw new Error(error.message);
    return data || [];
  }

  async getSessionLeaderboard(sessionId: string) {
    const participants = await this.getSessionParticipants(sessionId);
    return participants.map((p, index) => ({
      rank: index + 1,
      participant_id: p.id,
      pseudo: p.pseudo,
      score: p.score,
      last_points: 0,
      answered_current: false,
    }));
  }

  async getSessionResults(sessionId: string) {
    const session = await this.getSessionWithDetails(sessionId);
    const participants = await this.getSessionParticipants(sessionId);

    // Récupérer toutes les réponses de la session
    const { data: answers } = await this.supabase
      .from('participant_answers')
      .select('*')
      .eq('session_id', sessionId);

    const leaderboard = participants.map((p, index) => ({
      rank: index + 1,
      participant_id: p.id,
      pseudo: p.pseudo,
      score: p.score,
    }));

    return {
      session,
      leaderboard,
      total_answers: answers?.length || 0,
    };
  }

  // ============================================================
  // HELPERS
  // ============================================================

  async assertCreatorSession(sessionId: string, creatorId: string) {
    const { data: session } = await this.supabase
      .from('sessions')
      .select('creator_id')
      .eq('id', sessionId)
      .single();

    if (!session) throw new NotFoundException('Session introuvable');
    if (session.creator_id !== creatorId) {
      throw new ForbiddenException('Accès refusé');
    }

    return session;
  }

  async updateSessionStatus(
    sessionId: string,
    status: 'waiting' | 'active' | 'paused' | 'finished',
  ) {
    const updates: any = { status };
    if (status === 'active') updates.started_at = new Date().toISOString();
    if (status === 'finished') updates.ended_at = new Date().toISOString();

    const { data, error } = await this.supabase
      .from('sessions')
      .update(updates)
      .eq('id', sessionId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  async setCurrentQuestion(sessionId: string, questionIndex: number) {
    const { data, error } = await this.supabase
      .from('sessions')
      .update({
        current_question_index: questionIndex,
        question_start_time: new Date().toISOString(),
        status: 'active',
      })
      .eq('id', sessionId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  async updateParticipantSocketId(participantId: string, socketId: string) {
    await this.supabase
      .from('participants')
      .update({ socket_id: socketId })
      .eq('id', participantId);
  }

  async updateParticipantStatus(
    participantId: string,
    status: string,
  ) {
    await this.supabase
      .from('participants')
      .update({ status })
      .eq('id', participantId);
  }

  async updateParticipantScore(participantId: string, additionalPoints: number) {
    const { data: participant } = await this.supabase
      .from('participants')
      .select('score')
      .eq('id', participantId)
      .single();

    if (!participant) return;

    await this.supabase
      .from('participants')
      .update({ score: participant.score + additionalPoints, status: 'answered' })
      .eq('id', participantId);
  }
}
