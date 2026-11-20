import { Module } from "@nestjs/common";
import { SessionModule } from "../session/session.module";
import { AssignmentController } from "./assignment.controller";
import { AssignmentService } from "./assignment.service";

@Module({
  imports: [SessionModule],
  controllers: [AssignmentController],
  providers: [AssignmentService],
})
export class AssignmentModule {}
