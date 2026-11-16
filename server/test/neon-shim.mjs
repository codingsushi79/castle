// Stands in for @neondatabase/serverless in tests: the same tagged-template API over PGlite,
// an in-process Postgres, so the real server code runs against a real database.
import { PGlite } from "@electric-sql/pglite";

export const db = (globalThis.__castleTestDb ??= new PGlite());

export function neon() {
  const sql = async (strings, ...values) => {
    let text = strings[0];
    values.forEach((_, i) => { text += `$${i + 1}` + strings[i + 1]; });
    return (await db.query(text, values)).rows;
  };
  sql.query = async (text, params = []) => (await db.query(text, params)).rows;
  return sql;
}
