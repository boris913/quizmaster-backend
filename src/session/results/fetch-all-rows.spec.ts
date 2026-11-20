import { fetchAllRows } from "./fetch-all-rows";

/** Simule une table de `total` lignes servie par pages via range(from, to). */
function fakeTable(total: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const calls: [number, number][] = [];
  const makePage = jest.fn(async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null };
  });
  return { rows, calls, makePage };
}

describe("fetchAllRows", () => {
  it("lit toutes les pages jusqu'à une page incomplète", async () => {
    const { rows, calls, makePage } = fakeTable(2050);

    await expect(fetchAllRows(makePage, 1000)).resolves.toEqual(rows);
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("fait une requête supplémentaire si le total est un multiple de la page", async () => {
    const { rows, calls, makePage } = fakeTable(2000);

    await expect(fetchAllRows(makePage, 1000)).resolves.toEqual(rows);
    expect(calls).toHaveLength(3);
  });

  it("renvoie un tableau vide pour une table vide ou data null", async () => {
    await expect(fetchAllRows(fakeTable(0).makePage)).resolves.toEqual([]);
    await expect(
      fetchAllRows(async () => ({ data: null, error: null })),
    ).resolves.toEqual([]);
  });

  it("propage l'erreur d'une page", async () => {
    const makePage = jest
      .fn()
      .mockResolvedValueOnce({ data: [{ id: 1 }, { id: 2 }], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } });

    await expect(fetchAllRows(makePage, 2)).rejects.toThrow("boom");
  });

  it("refuse une taille de page invalide", async () => {
    await expect(fetchAllRows(fakeTable(1).makePage, 0)).rejects.toThrow();
  });
});
