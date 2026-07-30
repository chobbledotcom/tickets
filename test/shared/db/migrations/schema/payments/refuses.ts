import type { InStatement } from "@libsql/client";
import { expect } from "@std/expect";
import { getDb } from "#shared/db/client.ts";

/** Runs a write the tables are meant to turn away, naming the kind of rule
 *  that has to be the one turning it away. Takes a statement with values
 *  bound as well as plain SQL, because some values — bytes especially —
 *  cannot be written out as text. */
const refusedBy =
  (kind: string) =>
  async (statement: InStatement): Promise<void> => {
    await expect(getDb().execute(statement)).rejects.toThrow(
      `${kind} constraint failed`,
    );
  };

/** Turned away because the row breaks a rule about what it may say. */
export const expectRefused: (statement: InStatement) => Promise<void> =
  refusedBy("CHECK");

/** Turned away because the same thing is already written down. */
export const expectRefusedAsRepeat: (statement: InStatement) => Promise<void> =
  refusedBy("UNIQUE");

/** Runs a write the tables are meant to accept. */
export const expectAccepted = async (sql: string): Promise<void> => {
  await getDb().execute(sql);
};
