import { HttpException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiQuotaService, monthWindow } from "./ai-quota.service";
import { createSupabaseMock } from "../test-utils/supabase.mock";

function setup(env: Record<string, string | undefined> = {}) {
  const supabase = createSupabaseMock();
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return { supabase, service: new AiQuotaService(supabase.client, config) };
}

describe("AiQuotaService (issue #11)", () => {
  const now = new Date("2026-11-20T10:00:00Z");

  it("fenêtre mensuelle en UTC", () => {
    const { start, end } = monthWindow(new Date("2026-12-31T23:59:00Z"));
    expect(start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("AI_MONTHLY_QUOTA : 3 par défaut, valeur configurée sinon", () => {
    expect(setup().service.limit).toBe(3);
    expect(setup({ AI_MONTHLY_QUOTA: "10" }).service.limit).toBe(10);
    expect(setup({ AI_MONTHLY_QUOTA: "0" }).service.limit).toBe(0);
    expect(setup({ AI_MONTHLY_QUOTA: "abc" }).service.limit).toBe(3);
  });

  it("compte les générations du mois courant de l'utilisateur", async () => {
    const { supabase, service } = setup();
    supabase.mockResponse("ai_generations", { count: 2 });
    const status = await service.getStatus("u1", now);
    expect(status).toEqual({
      limit: 3,
      used: 2,
      remaining: 1,
      resets_at: "2026-12-01T00:00:00.000Z",
    });
    const calls = supabase.queriesFor("ai_generations")[0].calls;
    expect(calls).toContainEqual({ method: "eq", args: ["user_id", "u1"] });
    expect(calls).toContainEqual({
      method: "gte",
      args: ["created_at", "2026-11-01T00:00:00.000Z"],
    });
  });

  it("429 quand le quota est atteint", async () => {
    const { supabase, service } = setup();
    supabase.mockResponse("ai_generations", { count: 3 });
    const error = await service.assertAvailable("u1", now).catch((e) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse().quota).toMatchObject({ used: 3, remaining: 0 });
  });

  it("réserve une ligne puis renvoie l'état du quota", async () => {
    const { supabase, service } = setup();
    supabase
      .mockResponse("ai_generations", { data: { id: "g1" } })
      .mockResponse("ai_generations", { count: 1 });
    const reservation = await service.reserve("u1", now);
    expect(reservation).toEqual({
      id: "g1",
      status: expect.objectContaining({ used: 1, remaining: 2 }),
    });
    expect(supabase.queriesFor("ai_generations")[0].calls[0]).toEqual({
      method: "insert",
      args: [{ user_id: "u1" }],
    });
  });

  it("annule la réservation si des requêtes concurrentes dépassent le quota", async () => {
    const { supabase, service } = setup();
    supabase
      .mockResponse("ai_generations", { data: { id: "g4" } })
      .mockResponse("ai_generations", { count: 4 });
    const error = await service.reserve("u1", now).catch((e) => e);
    expect(error.getStatus()).toBe(429);
    const del = supabase.queriesFor("ai_generations")[2].calls;
    expect(del).toEqual([
      { method: "delete", args: [] },
      { method: "eq", args: ["id", "g4"] },
    ]);
  });
});
