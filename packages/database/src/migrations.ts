import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { Pool } from "pg";

import { withTransaction } from "./client.ts";
import type { DatabaseConfig } from "./config.ts";
import { MigrationError, UnsafeTestDatabaseError } from "./errors.ts";

export interface MigrationStatus {
  readonly name: string;
  readonly checksum: string;
  readonly applied: boolean;
}

export async function runMigrations(
  pool: Pool,
  migrationsDirectory = defaultMigrationsDirectory(),
): Promise<readonly MigrationStatus[]> {
  await ensureMigrationTable(pool);
  const migrations = await readMigrationFiles(migrationsDirectory);
  const applied = await readAppliedMigrations(pool);

  for (const migration of migrations) {
    const previousChecksum = applied.get(migration.name);
    if (
      previousChecksum !== undefined &&
      previousChecksum !== migration.checksum
    ) {
      throw new MigrationError(
        migration.name,
        "checksum differs from the applied migration",
      );
    }

    if (previousChecksum !== undefined) {
      continue;
    }

    try {
      await withTransaction(pool, async (client) => {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO schema_migrations (name, checksum)
           VALUES ($1, $2)`,
          [migration.name, migration.checksum],
        );
      });
    } catch (error) {
      throw new MigrationError(migration.name, errorMessage(error));
    }
  }

  return getMigrationStatus(pool, migrationsDirectory);
}

export async function getMigrationStatus(
  pool: Pool,
  migrationsDirectory = defaultMigrationsDirectory(),
): Promise<readonly MigrationStatus[]> {
  await ensureMigrationTable(pool);
  const migrations = await readMigrationFiles(migrationsDirectory);
  const applied = await readAppliedMigrations(pool);

  return migrations.map((migration) => ({
    name: migration.name,
    checksum: migration.checksum,
    applied: applied.get(migration.name) === migration.checksum,
  }));
}

export async function resetTestDatabase(
  pool: Pool,
  config: DatabaseConfig,
): Promise<void> {
  assertSafeTestDatabase(config.database);

  await withTransaction(pool, async (client) => {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  });

  await runMigrations(pool);
}

export function assertSafeTestDatabase(database: string): void {
  if (!database.endsWith("_test")) {
    throw new UnsafeTestDatabaseError(database);
  }
}

function defaultMigrationsDirectory(): string {
  return resolve(process.cwd(), "packages/database/migrations");
}

async function ensureMigrationTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function readAppliedMigrations(
  pool: Pool,
): Promise<ReadonlyMap<string, string>> {
  const result = await pool.query<{
    readonly name: string;
    readonly checksum: string;
  }>("SELECT name, checksum FROM schema_migrations");

  return new Map(result.rows.map((row) => [row.name, row.checksum]));
}

async function readMigrationFiles(directory: string): Promise<
  readonly {
    readonly name: string;
    readonly checksum: string;
    readonly sql: string;
  }[]
> {
  const names = (await readdir(directory))
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort();

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(resolve(directory, name), "utf8");
      return {
        name,
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown migration error";
}
