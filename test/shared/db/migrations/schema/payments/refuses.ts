import { expect } from "@std/expect";
import { getDb } from "#shared/db/client.ts";

/** Runs a write the tables are meant to turn away, and says so if it got in. */
export const expectRefused = async (sql: string): Promise<void> => {
  await expect(getDb().execute(sql)).rejects.toThrow("CHECK constraint failed");
};

/** Runs a write the tables are meant to accept. */
export const expectAccepted = async (sql: string): Promise<void> => {
  await getDb().execute(sql);
};
