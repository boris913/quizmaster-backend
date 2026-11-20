import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { JoinSessionDto } from "./session.dto";

/** Reproduit le ValidationPipe global (transform: true) de main.ts. */
async function toDto(plain: Record<string, unknown>) {
  const dto = plainToInstance(JoinSessionDto, plain);
  const errors = await validate(dto);
  return { dto, errors };
}

describe("JoinSessionDto : normalisation du code", () => {
  it("normalise le code avant la validation de longueur", async () => {
    const { dto, errors } = await toDto({
      password: "  ab c2 34 ",
      pseudo: "Alice",
    });
    expect(errors).toHaveLength(0);
    expect(dto.password).toBe("ABC234");
  });

  it("refuse toujours un code de mauvaise longueur", async () => {
    const { errors } = await toDto({ password: "ab c2", pseudo: "Alice" });
    expect(errors.map((e) => e.property)).toContain("password");
  });

  it("laisse une valeur non textuelle à la validation", async () => {
    const { errors } = await toDto({ password: 123456, pseudo: "Alice" });
    expect(errors.map((e) => e.property)).toContain("password");
  });
});
