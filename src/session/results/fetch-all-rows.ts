/**
 * Lecture paginée d'une requête Supabase.
 *
 * PostgREST tronque silencieusement les réponses au-delà de `max-rows`
 * (1000 par défaut sur Supabase) : 35 élèves × 30 questions suffisent à
 * dépasser cette limite sur `participant_answers`. On lit donc par pages
 * avec `.range(from, to)` jusqu'à recevoir une page incomplète.
 *
 * `makePage` doit construire une NOUVELLE requête à chaque appel (un query
 * builder Supabase ne s'exécute qu'une fois) et l'ordonner de façon
 * déterministe (ex. `.order("id")`), sinon la pagination n'est pas stable.
 *
 * `pageSize` ne doit pas dépasser le `max-rows` du projet : une page
 * plafonnée par le serveur serait prise pour la dernière.
 */
export const DEFAULT_PAGE_SIZE = 1000;

export interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export async function fetchAllRows<T>(
  makePage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`Taille de page invalide : ${pageSize}`);
  }

  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makePage(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
