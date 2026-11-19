/**
 * Mock chaînable du client Supabase pour les tests unitaires de services.
 *
 * Usage :
 *
 *   const supabase = createSupabaseMock();
 *   supabase.mockResponse("participants", { data: { id: "p1" } });
 *   supabase.mockResponse("participant_answers", { data: [] });
 *
 *   const module = await Test.createTestingModule({
 *     providers: [
 *       MyService,
 *       { provide: SUPABASE_CLIENT, useValue: supabase.client },
 *     ],
 *   }).compile();
 *
 * Chaque appel à `from(table)` consomme la prochaine réponse enregistrée pour
 * cette table (ordre FIFO). Si aucune réponse n'est en attente, la requête
 * renvoie `{ data: null, error: null }`.
 *
 * Toute la chaîne (`select().eq().order()...`) est enregistrée dans
 * `supabase.queries` pour pouvoir vérifier les appels effectués.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface MockResponse<T = unknown> {
  data?: T | null;
  error?: { message: string; code?: string; [key: string]: unknown } | null;
  count?: number | null;
}

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export interface RecordedQuery {
  /** Nom de la table (ou `rpc:<fonction>` pour un appel RPC). */
  table: string;
  calls: RecordedCall[];
}

/** Méthodes du query builder qui renvoient le builder (chaînables). */
const CHAINABLE_METHODS = [
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "contains",
  "containedBy",
  "match",
  "not",
  "or",
  "filter",
  "textSearch",
  "order",
  "limit",
  "range",
  "returns",
] as const;

/** Méthodes terminales qui renvoient directement une promesse. */
const TERMINAL_METHODS = ["single", "maybeSingle", "csv"] as const;

type ChainableMethod = (typeof CHAINABLE_METHODS)[number];
type TerminalMethod = (typeof TERMINAL_METHODS)[number];

export type MockQueryBuilder = {
  [K in ChainableMethod]: jest.Mock<MockQueryBuilder, unknown[]>;
} & {
  [K in TerminalMethod]: jest.Mock<Promise<Required<MockResponse>>, unknown[]>;
} & PromiseLike<Required<MockResponse>>;

export interface SupabaseMock {
  /** À injecter à la place du vrai client (token SUPABASE_CLIENT). */
  client: SupabaseClient;
  /** Ajoute une réponse à la file d'attente d'une table. */
  mockResponse<T>(table: string, response: MockResponse<T>): SupabaseMock;
  /** Ajoute une réponse à la file d'attente d'une fonction RPC. */
  mockRpcResponse<T>(fn: string, response: MockResponse<T>): SupabaseMock;
  /** Toutes les requêtes exécutées, dans l'ordre. */
  queries: RecordedQuery[];
  /** Requêtes exécutées sur une table donnée. */
  queriesFor(table: string): RecordedQuery[];
  /** Vide les files de réponses et l'historique. */
  reset(): void;
}

function normalize<T>(response: MockResponse<T>): Required<MockResponse<T>> {
  return {
    data: response.data ?? null,
    error: response.error ?? null,
    count: response.count ?? null,
  };
}

function createQueryBuilder(
  query: RecordedQuery,
  response: Required<MockResponse>,
): MockQueryBuilder {
  const builder = {} as MockQueryBuilder;

  for (const method of CHAINABLE_METHODS) {
    builder[method] = jest.fn((...args: unknown[]) => {
      query.calls.push({ method, args });
      return builder;
    });
  }

  for (const method of TERMINAL_METHODS) {
    builder[method] = jest.fn((...args: unknown[]) => {
      query.calls.push({ method, args });
      return Promise.resolve(response);
    });
  }

  // Rend le builder « awaitable » comme le vrai PostgrestFilterBuilder.
  (builder as { then: PromiseLike<unknown>["then"] }).then = (
    onFulfilled,
    onRejected,
  ) => Promise.resolve(response).then(onFulfilled, onRejected);

  return builder;
}

export function createSupabaseMock(): SupabaseMock {
  const queues = new Map<string, Required<MockResponse>[]>();
  const queries: RecordedQuery[] = [];

  const enqueue = (key: string, response: MockResponse) => {
    const queue = queues.get(key) ?? [];
    queue.push(normalize(response));
    queues.set(key, queue);
  };

  const dequeue = (key: string): Required<MockResponse> =>
    queues.get(key)?.shift() ?? normalize({});

  const from = jest.fn((table: string) => {
    const query: RecordedQuery = { table, calls: [] };
    queries.push(query);
    return createQueryBuilder(query, dequeue(table));
  });

  const rpc = jest.fn((fn: string, args?: unknown) => {
    const key = `rpc:${fn}`;
    const query: RecordedQuery = {
      table: key,
      calls: [{ method: "rpc", args: [fn, args] }],
    };
    queries.push(query);
    return createQueryBuilder(query, dequeue(key));
  });

  const mock: SupabaseMock = {
    client: { from, rpc } as unknown as SupabaseClient,
    mockResponse(table, response) {
      enqueue(table, response);
      return mock;
    },
    mockRpcResponse(fn, response) {
      enqueue(`rpc:${fn}`, response);
      return mock;
    },
    queries,
    queriesFor: (table) => queries.filter((q) => q.table === table),
    reset() {
      queues.clear();
      queries.length = 0;
      from.mockClear();
      rpc.mockClear();
    },
  };

  return mock;
}
