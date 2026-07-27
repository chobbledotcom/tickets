import {
  type Client,
  createClient,
  type TransactionMode,
} from "@libsql/client";
import { beginTransaction } from "#shared/db/libsql-call.ts";
import { proxyMembers } from "#shared/proxy-members.ts";

/** Speed settings every test database connection runs with. Nothing in a test
 * database has to survive a crash, so writes never wait for the disk: with
 * these settings a write costs about 0.02ms, without them about 4ms. */
const FAST_WRITE_SETTINGS =
  "PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;";

/**
 * Open a test database file with those speed settings, and keep them in place
 * for the life of the client.
 *
 * The settings belong to one *connection*, and libsql gives its connection away
 * whenever an interactive transaction starts (`withTransaction`), then opens a
 * fresh, plain one for every statement that follows. So a single transaction
 * used to leave the rest of the test file waiting on the disk for each write.
 * Setting the replacement connection up straight away keeps every later
 * statement fast.
 */
export const createTestDbClient = async (path: string): Promise<Client> => {
  const client = createClient({ url: `file:${path}` });
  await client.executeMultiple(FAST_WRITE_SETTINGS);
  return proxyMembers(client, {
    transaction: async (mode?: TransactionMode) => {
      const transaction = await beginTransaction(client, mode);
      // The transaction now owns the old connection; set up the new one before
      // any other statement can land on it.
      await client.executeMultiple(FAST_WRITE_SETTINGS);
      return transaction;
    },
  });
};
