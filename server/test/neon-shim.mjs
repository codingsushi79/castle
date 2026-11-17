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

/** The WebSocket Client, as far as LISTEN/NOTIFY goes, over PGlite. */
export const neonConfig = {};
export class Client {
  handlers = {};
  constructor() {}
  on(event, cb) { this.handlers[event] = cb; }
  async connect() {}
  async query(text) {
    const m = /^LISTEN (\w+)/i.exec(text);
    if (m) await db.listen(m[1], (payload) => this.handlers.notification?.({ channel: m[1], payload }));
    return { rows: [] };
  }
  async end() {}
}
