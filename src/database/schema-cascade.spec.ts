import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Garde-fou RGPD (issue #9) : `DELETE /api/sessions/:id` ne supprime que la
 * ligne `sessions` et s'appuie sur les clés étrangères `ON DELETE CASCADE`
 * pour effacer participants et réponses. Ce test vérifie, dans les migrations,
 * que ces clés existent et qu'aucune migration ultérieure ne les retire.
 */
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

function readMigrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8"),
    }));
}

/** Corps du `CREATE TABLE <table> (...)` dans le schéma initial. */
function tableDefinition(sql: string, table: string): string {
  const match = sql.match(
    new RegExp(
      `CREATE TABLE (?:IF NOT EXISTS )?${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
    ),
  );
  if (!match) throw new Error(`Table ${table} introuvable`);
  return match[1];
}

function columnLine(definition: string, column: string): string {
  const line = definition
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${column} `));
  if (!line) throw new Error(`Colonne ${column} introuvable`);
  return line;
}

describe("Schéma : suppression en cascade d'une session", () => {
  const migrations = readMigrations();
  const initial = migrations.find((m) => m.name.startsWith("000_"));

  it("le schéma initial est présent", () => {
    expect(initial).toBeDefined();
  });

  it.each([
    ["participants", "session_id", "sessions"],
    ["participant_answers", "session_id", "sessions"],
    ["participant_answers", "participant_id", "participants"],
  ])("%s.%s référence %s avec ON DELETE CASCADE", (table, column, target) => {
    const line = columnLine(tableDefinition(initial!.sql, table), column);
    expect(line).toMatch(
      new RegExp(`REFERENCES ${target}\\(id\\) ON DELETE CASCADE`),
    );
  });

  it("aucune migration ultérieure ne supprime ces clés étrangères", () => {
    // Noms par défaut générés par PostgreSQL pour les FK ci-dessus
    const fkNames =
      /DROP CONSTRAINT\s+(?:IF EXISTS\s+)?"?(participants_session_id_fkey|participant_answers_session_id_fkey|participant_answers_participant_id_fkey)/i;
    for (const { name, sql } of migrations.filter((m) => m !== initial)) {
      expect({ name, dropsFk: fkNames.test(sql) }).toEqual({
        name,
        dropsFk: false,
      });
    }
  });
});
