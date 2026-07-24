import { checkDatabaseConnection, createDatabasePool } from "./client.ts";
import { loadDatabaseConfig } from "./config.ts";
import {
  getMigrationStatus,
  resetTestDatabase,
  runMigrations,
} from "./migrations.ts";

const command = process.argv[2];
const config = loadDatabaseConfig();
const pool = createDatabasePool(config);

try {
  await checkDatabaseConnection(pool);

  switch (command) {
    case "migrate": {
      const status = await runMigrations(pool);
      for (const migration of status) {
        console.log(`${migration.applied ? "applied" : "pending"} ${migration.name}`);
      }
      break;
    }
    case "status": {
      const status = await getMigrationStatus(pool);
      for (const migration of status) {
        console.log(`${migration.applied ? "applied" : "pending"} ${migration.name}`);
      }
      break;
    }
    case "reset-test":
      await resetTestDatabase(pool, config);
      console.log(`Test database ${config.database} reset and migrated.`);
      break;
    default:
      throw new Error("Expected command: migrate, status, or reset-test.");
  }
} finally {
  await pool.end();
}
