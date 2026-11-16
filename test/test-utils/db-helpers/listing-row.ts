import { encrypt } from "#crypto/encryption.ts";
import { tables } from "#db/select/tables.ts";
import type { SqlStatement } from "#db/sql.ts";
import { insertInto, type NewValues } from "#db/write.ts";

/** A statement that adds one bare listing row, with no app code around it,
 *  for a database that the app has not opened yet. */
export const listingRowStatement = async (
  name: string,
  values: Partial<NewValues<"listings">> = {},
): Promise<SqlStatement> =>
  insertInto(tables.listings, {
    created: "2024-01-01T00:00:00Z",
    max_attendees: 100,
    name: await encrypt(name),
    ...values,
  });
