import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  generateResumeToken,
  hashResumeToken,
  isWellFormedResumeToken,
  safeEqualHex,
  seededShuffle,
} from "./assignment.util";
import {
  StartAssignmentDto,
  SubmitAssignmentAnswerDto,
} from "./dto/assignment.dto";

/** Reproduit le ValidationPipe global de main.ts. */
async function errorsFor(cls: any, plain: Record<string, unknown>) {
  const errors = await validate(plainToInstance(cls, plain) as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

describe("assignment.util", () => {
  it("génère des jetons de 256 bits, base64url, tous différents", () => {
    const tokens = new Set(Array.from({ length: 50 }, generateResumeToken));
    expect(tokens.size).toBe(50);
    for (const t of tokens) expect(isWellFormedResumeToken(t)).toBe(true);
  });

  it("empreinte SHA-256 hex de 64 caractères", () => {
    expect(hashResumeToken("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashResumeToken("abc")).toBe(hashResumeToken("abc"));
  });

  it("comparaison sûre : égalité, différence, longueur, absence", () => {
    const h = hashResumeToken("abc");
    expect(safeEqualHex(h, hashResumeToken("abc"))).toBe(true);
    expect(safeEqualHex(h, hashResumeToken("abd"))).toBe(false);
    expect(safeEqualHex(h, h.slice(1))).toBe(false);
    expect(safeEqualHex(h, null)).toBe(false);
    expect(safeEqualHex("", "")).toBe(false);
  });

  it("seededShuffle est déterministe et ne modifie pas l'entrée", () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    const copy = [...input];
    const a = seededShuffle(input, "graine");
    expect(seededShuffle(input, "graine")).toEqual(a);
    expect(input).toEqual(copy);
    expect([...a].sort((x, y) => x - y)).toEqual(input);
    expect(seededShuffle(input, "autre")).not.toEqual(a);
  });
});

describe("DTO des devoirs", () => {
  it("answer : refuse un temps ou un score envoyé par le client", async () => {
    const props = await errorsFor(SubmitAssignmentAnswerDto, {
      questionId: "11111111-1111-4111-8111-111111111111",
      answers: ["A"],
      timeTakenMs: 10,
      points: 100,
    });
    expect(props).toEqual(expect.arrayContaining(["timeTakenMs", "points"]));
  });

  it("answer : accepte une réponse valide", async () => {
    expect(
      await errorsFor(SubmitAssignmentAnswerDto, {
        questionId: "11111111-1111-4111-8111-111111111111",
        answers: ["A", "C"],
      }),
    ).toEqual([]);
  });

  it("answer : refuse un identifiant ou des réponses invalides", async () => {
    expect(
      await errorsFor(SubmitAssignmentAnswerDto, {
        questionId: "pas-un-uuid",
        answers: "A",
      }),
    ).toEqual(expect.arrayContaining(["questionId", "answers"]));
  });

  it("start : mêmes règles de pseudo que POST /sessions/join", async () => {
    expect(
      await errorsFor(StartAssignmentDto, { pseudo: "Loutre Curieuse" }),
    ).toEqual([]);
    expect(await errorsFor(StartAssignmentDto, { pseudo: "a" })).toEqual([
      "pseudo",
    ]);
    expect(await errorsFor(StartAssignmentDto, { pseudo: "<script>" })).toEqual(
      ["pseudo"],
    );
  });
});
