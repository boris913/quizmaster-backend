import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { SessionService } from "./session.service";
import {
  CreateSessionDto,
  JoinSessionDto,
  NicknameSuggestionsQueryDto,
} from "./dto/session.dto";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import {
  CurrentUser,
  JwtPayload,
} from "../common/decorators/current-user.decorator";
import { Public } from "../common/decorators/public.decorator";

@Controller("sessions")
@UseGuards(JwtAuthGuard)
export class SessionController {
  constructor(private readonly sessionService: SessionService) {}

  /**
   * GET /api/sessions
   * Sessions du créateur connecté
   */
  @Get()
  getCreatorSessions(@CurrentUser() user: JwtPayload) {
    return this.sessionService.getCreatorSessions(user.sub);
  }

  /**
   * GET /api/sessions/join/nicknames?code=XXXXXX
   * Trois propositions de pseudo pour la session (public). Déclarée avant
   * les routes `:id` pour ne pas être capturée par elles.
   */
  @Public()
  @Get("join/nicknames")
  getNicknameSuggestions(@Query() query: NicknameSuggestionsQueryDto) {
    return this.sessionService.getNicknameSuggestions(query.code);
  }

  /**
   * GET /api/sessions/:id
   * Détail d'une session (créateur seulement)
   */
  @Get(":id")
  getSession(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.sessionService.getSessionByCreator(id, user.sub);
  }

  /**
   * GET /api/sessions/:id/participants
   * Liste des participants d'une session (créateur seulement)
   */
  @Get(":id/participants")
  getParticipants(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.sessionService.getSessionParticipantsForCreator(id, user.sub);
  }

  /**
   * GET /api/sessions/:id/leaderboard
   * Classement d'une session (créateur seulement)
   */
  @Get(":id/leaderboard")
  getLeaderboard(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.sessionService.getSessionLeaderboardForCreator(id, user.sub);
  }

  /**
   * GET /api/sessions/:id/results
   * Résultats finaux d'une session (créateur seulement)
   */
  @Get(":id/results")
  getResults(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.sessionService.getSessionResults(id, user.sub);
  }

  /**
   * AMÉLIORATION AUDIT #6: Reconnexion d'un participant
   * GET /api/sessions/:id/reconnect/:participantId
   */
  @Public()
  @Get(":id/reconnect/:participantId")
  async reconnect(
    @Param("id") sessionId: string,
    @Param("participantId") participantId: string,
  ) {
    return this.sessionService.reconnectParticipant(sessionId, participantId);
  }

  /**
   * POST /api/sessions
   * Créer une nouvelle session de quiz (créateur authentifié)
   */
  @Post()
  createSession(
    @Body() dto: CreateSessionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.sessionService.createSession(user.sub, dto);
  }

  /**
   * POST /api/sessions/join
   * Rejoindre une session via mot de passe + pseudo (public)
   */
  @Public()
  @Post("join")
  joinSession(@Body() dto: JoinSessionDto) {
    return this.sessionService.joinSession(dto);
  }

  /**
   * DELETE /api/sessions/:id
   * Terminer/fermer une session
   */
  @Delete(":id")
  endSession(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.sessionService.endSession(id, user.sub);
  }
}
