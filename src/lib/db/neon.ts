import { Pool } from "pg";

// Read-only access to Doott's Neon Postgres (final.people ~45M rows, final.companies ~1.6M rows).
// Every query runs inside a READ ONLY transaction with a statement timeout.

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.NEON_DATABASE_URL || process.env.NEON_DIRECT_URL;
    if (!connectionString) throw new Error("NEON_DATABASE_URL is not set");
    pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 15_000, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

export async function readOnlyQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  timeoutMs = 25_000,
): Promise<T[]> {
  const conn = await getPool().connect();
  try {
    await conn.query("BEGIN READ ONLY");
    await conn.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    const res = await conn.query(sql, params);
    await conn.query("COMMIT");
    return res.rows as T[];
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}
