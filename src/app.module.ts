import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { QuizModule } from './quiz/quiz.module';
import { SessionModule } from './session/session.module';
import { ParticipantModule } from './participant/participant.module';
import { DatabaseModule } from './database/database.module';
import { QuizGateway } from './gateway/quiz.gateway';
import { GatewayModule } from './gateway/gateway.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    DatabaseModule,
    AuthModule,
    QuizModule,
    SessionModule,
    ParticipantModule,
    GatewayModule,
  ],
})
export class AppModule {}
