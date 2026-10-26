/**
 * Prepare a migrated, setup-complete database for a fresh-process boot
 * child: open the node-side client, run the migrations, and complete site
 * setup so the booted app finds a ready database. Returns the client. The
 * database module graph is imported inside the function because nothing may
 * read the environment before the caller sets DB_URL (see the cold-start
 * benchmarks).
 */

import type { Client } from "@libsql/client";

export const prepareBootDatabase = async (
  dbUrl: string,
  adminName: string,
  adminPassword: string,
): Promise<Client> => {
  const { createClient } = await import("@libsql/client");
  const { setDb } = await import("#db/client.ts");
  const { initDb } = await import("#db/migrations.ts");
  const { settings } = await import("#db/settings.ts");

  const db = await createClient({ url: dbUrl });
  setDb(db);
  await initDb({ allowMissingSettings: true });
  await settings.setup.complete(adminName, adminPassword, "GB");
  return db;
};
