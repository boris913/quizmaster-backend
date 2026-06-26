import { Module } from "@nestjs/common";
import { QuizGateway } from "./quiz.gateway";
import { AuthModule } from "../auth/auth.module";
import { SessionModule } from "../session/session.module";
import { ParticipantModule } from "../participant/participant.module";

@Module({
  imports: [AuthModule, SessionModule, ParticipantModule],
  providers: [QuizGateway],
  exports: [QuizGateway],
})
export class GatewayModule {}
