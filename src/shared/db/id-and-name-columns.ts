import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { type ColumnDef, col } from "#shared/db/table.ts";

/** The two columns a simple named lookup table always shares: an auto-generated
 * numeric id and an encrypted name. Spread it into the table's `schema` and add
 * whatever extra columns that table needs. */
export const idAndEncryptedName = (): {
  id: ColumnDef<number>;
  name: ColumnDef<string>;
} => ({
  id: col.generated<number>(),
  name: col.encrypted(encrypt, decrypt),
});
