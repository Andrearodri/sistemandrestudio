import type { PoolConfig } from "pg";

import { DatabaseConfigError } from "./errors.ts";

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly ssl: boolean;
}

export function loadDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const host = required(environment, "POSTGRES_HOST");
  const user = required(environment, "POSTGRES_USER");
  const password = required(environment, "POSTGRES_PASSWORD");
  const database = required(environment, "POSTGRES_DB");
  const portValue = required(environment, "POSTGRES_PORT");
  const port = Number(portValue);

  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new DatabaseConfigError("POSTGRES_PORT");
  }

  const sslValue = environment.POSTGRES_SSL ?? "false";
  if (sslValue !== "true" && sslValue !== "false") {
    throw new DatabaseConfigError("POSTGRES_SSL");
  }

  return {
    host,
    port,
    user,
    password,
    database,
    ssl: sslValue === "true",
  };
}

export function toPoolConfig(config: DatabaseConfig): PoolConfig {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl,
    application_name: "sistemandrestudio",
    max: 8,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  };
}

function required(environment: NodeJS.ProcessEnv, field: string): string {
  const value = environment[field];
  if (value === undefined || value.trim().length === 0) {
    throw new DatabaseConfigError(field);
  }
  return value;
}
