import {
  type Client,
  createClient,
  type InStatement,
  type TransactionMode,
} from "@libsql/client";
import { beginTransaction, wrapExecute } from "#shared/db/libsql-call.ts";
import { proxyMembers } from "#shared/proxy-members.ts";
import { reclaimLeakedFdsNow } from "#test-utils/reclaim-fds.ts";

/** Speed settings every test database connection runs with. Nothing in a test
 * database has to survive a crash, so writes never wait for the disk: with
 * these settings a write costs about 0.02ms, without them about 4ms. */
const FAST_WRITE_SETTINGS =
  "PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;";

/** Whether this failure is SQLite's contended-write answer. Mirrors the shape
 * the production client retries on, but for a different job: here it picks
 * which failures warrant freeing abandoned connections first. */
const isWriteLockContention = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("SQLITE_BUSY") ||
    error.message.toLowerCase().includes("database is locked"));

/**
 * Run one client call, freeing abandoned connections when it loses the write
 * lock. libsql's local client abandons each interactive transaction's
 * connection (see reclaim-fds.ts), and an abandoned connection can sit on the
 * file's write lock until garbage collection finalises it — a phantom holder
 * no live code can release. Freeing it here means the production client's
 * normal retry, which follows this failure, finds the lock free instead of
 * dying as DatabaseBusyError after a full backoff ladder.
 */
const freeAbandonedConnectionsOnBusy = async <T>(
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (isWriteLockContention(error)) reclaimLeakedFdsNow();
    throw error;
  }
};

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
    batch: (statements: InStatement[], mode?: TransactionMode) =>
      freeAbandonedConnectionsOnBusy(() => client.batch(statements, mode)),
    // wrapExecute keeps both execute call shapes — (sql, args) and one
    // statement object — forwarding exactly as the real client expects.
    execute: wrapExecute(client, (_statement, run) =>
      freeAbandonedConnectionsOnBusy(run),
    ),
    transaction: async (mode?: TransactionMode) => {
      const transaction = await freeAbandonedConnectionsOnBusy(() =>
        beginTransaction(client, mode),
      );
      // The transaction now owns the old connection; set up the new one before
      // any other statement can land on it.
      await client.executeMultiple(FAST_WRITE_SETTINGS);
      return transaction;
    },
  });
};
