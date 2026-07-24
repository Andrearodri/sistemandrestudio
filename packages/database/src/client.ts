import { Pool } from "pg";
import type { PoolClient } from "pg";

import type { DatabaseConfig } from "./config.ts";
import { toPoolConfig } from "./config.ts";

export function createDatabasePool(config: DatabaseConfig): Pool {
  return new Pool(toPoolConfig(config));
}

export async function checkDatabaseConnection(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
