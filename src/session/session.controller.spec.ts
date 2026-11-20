import { NotFoundException } from "@nestjs/common";
import { SessionController } from "./session.controller";
import { SessionService } from "./session.service";

describe("SessionController : export CSV des résultats", () => {
  const user = { sub: "user-owner" } as any;

  function setup(service: Partial<SessionService>) {
    const controller = new SessionController(service as SessionService);
    const res = { setHeader: jest.fn() };
    return { controller, res };
  }

  it("renvoie le CSV en pièce jointe, en text/csv UTF-8", async () => {
    const getSessionResultsCsv = jest.fn().mockResolvedValue({
      filename: "resultats-quiz.csv",
      csv: "\uFEFFRang;Pseudo\r\n",
    });
    const { controller, res } = setup({ getSessionResultsCsv });

    const body = await controller.getResultsCsv("s1", user, res as any);

    expect(getSessionResultsCsv).toHaveBeenCalledWith("s1", "user-owner");
    expect(body).toBe("\uFEFFRang;Pseudo\r\n");
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "text/csv; charset=utf-8",
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      'attachment; filename="resultats-quiz.csv"',
    );
  });

  it("propage le 404 sans poser d'en-têtes", async () => {
    const getSessionResultsCsv = jest
      .fn()
      .mockRejectedValue(new NotFoundException("Session introuvable"));
    const { controller, res } = setup({ getSessionResultsCsv });

    await expect(
      controller.getResultsCsv("s1", user, res as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
