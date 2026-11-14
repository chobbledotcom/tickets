import type { Client } from "@libsql/client";
import { getDb } from "#db/client.ts";

/** The libsql client behind `getDb()`, with the SDK's own text methods. Only
 * for a test that replays SQL text it did not write, such as a wire request.
 * The one unsafe cast lives here. */
export const rawDbClient = (): Client => getDb() as unknown as Client;
