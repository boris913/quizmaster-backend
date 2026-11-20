import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";
import { AssignmentService } from "./assignment.service";
import {
  StartAssignmentDto,
  SubmitAssignmentAnswerDto,
} from "./dto/assignment.dto";
import { RESUME_TOKEN_HEADER } from "./assignment.util";

/**
 * Mode devoir asynchrone (issue #10). Routes publiques (aucun JWT) : l'élève
 * est identifié par le jeton de reprise reçu au `start`, renvoyé dans
 * l'en-tête `X-Resume-Token`. Une session live renvoie 404.
 */
@Controller("assignments")
export class AssignmentController {
  constructor(private readonly assignmentService: AssignmentService) {}

  /** POST /api/assignments/:code/start — body `{ pseudo }` */
  @Post(":code/start")
  @HttpCode(201)
  start(@Param("code") code: string, @Body() dto: StartAssignmentDto) {
    return this.assignmentService.start(code, dto.pseudo);
  }

  /** GET /api/assignments/:code/next — en-tête X-Resume-Token */
  @Get(":code/next")
  next(
    @Param("code") code: string,
    @Headers(RESUME_TOKEN_HEADER) resumeToken: string | undefined,
  ) {
    return this.assignmentService.next(code, resumeToken);
  }

  /** POST /api/assignments/:code/answer — en-tête X-Resume-Token */
  @Post(":code/answer")
  @HttpCode(200)
  answer(
    @Param("code") code: string,
    @Headers(RESUME_TOKEN_HEADER) resumeToken: string | undefined,
    @Body() dto: SubmitAssignmentAnswerDto,
  ) {
    return this.assignmentService.answer(code, resumeToken, dto);
  }
}
