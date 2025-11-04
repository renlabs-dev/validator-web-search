import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";
import { env } from "../env.js";

const { Pool } = pg;

interface GlobalForDb {
  pool: pg.Pool | undefined;
}

const globalForDb = globalThis as unknown as GlobalForDb;

export function createDb() {
  // Parse the connection string to check if SSL is required
  const url = new URL(env.POSTGRES_URL);
  const sslMode = url.searchParams.get('sslmode');

  const pool = globalForDb.pool ?? new Pool({
    connectionString: env.POSTGRES_URL,
    ssl: sslMode === 'require' ? {
      rejectUnauthorized: false
    } : undefined
  });

  if (env.NODE_ENV !== "production") {
    globalForDb.pool = pool;
  }

  const db = drizzle(pool, { schema });
  return db;
}

export type DB = ReturnType<typeof createDb>;
export type Transaction = Parameters<Parameters<DB["transaction"]>[0]>[0];
