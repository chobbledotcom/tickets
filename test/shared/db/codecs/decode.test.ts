/**
 * Tests for `src/shared/db/codecs/decode.ts` through the client: a typed read
 * gives decoded values on every path, and other reads give stored values.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { decrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import {
  executeBatchWithResults,
  getDb,
  queryAll,
  resultRows,
  withTransaction,
} from "#db/client.ts";
import { encoded } from "#db/codecs/decode.ts";
import { coalesce } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { insertInto } from "#db/write.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const holiday = {
  end_date: "2026-01-02",
  name: "New year",
  start_date: "2026-01-01",
};

const addHoliday = async (): Promise<void> => {
  await getDb().execute(
    insertInto(tables.holidays, await encoded(tables.holidays, holiday)),
  );
};

type StoredName = { name: EnvKeyEncrypted };

const nameRead = () => from(tables.holidays).pick("id", "name");

describeWithEnv(
  "decoding typed reads",
  { db: true, encryptionKey: true },
  () => {
    test("encodes a sealed column before the write", async () => {
      await addHoliday();
      const [row] = await queryAll<StoredName>(sql`SELECT name FROM holidays`);
      expect(row!.name).not.toBe("New year");
      expect(await decrypt(row!.name)).toBe("New year");
    });

    test("decodes a picked column on a single read", async () => {
      await addHoliday();
      expect(await queryAll(nameRead())).toEqual([{ id: 1, name: "New year" }]);
    });

    test("decodes each read of a batch in its place", async () => {
      await addHoliday();
      const [count, names] = await executeBatchWithResults([
        sql`SELECT COUNT(*) AS total FROM holidays`,
        nameRead(),
      ]);
      expect(resultRows(count)).toEqual([{ total: 1 }]);
      expect(resultRows(names)).toEqual([{ id: 1, name: "New year" }]);
    });

    test("decodes reads and batches inside a transaction", async () => {
      await addHoliday();
      const read = await withTransaction(async (tx) => [
        resultRows(await tx.execute(nameRead())),
        resultRows((await tx.batch([nameRead()]))[0]),
      ]);
      expect(read).toEqual([
        [{ id: 1, name: "New year" }],
        [{ id: 1, name: "New year" }],
      ]);
    });

    test("decodes the rows that a write returns", async () => {
      const rows = await queryAll(
        insertInto(
          tables.holidays,
          await encoded(tables.holidays, holiday),
        ).returning("name"),
      );
      expect(rows).toEqual([{ name: "New year" }]);
    });

    test("leaves a value worked out from a column as it is stored", async () => {
      await addHoliday();
      const [row] = await queryAll(
        from(tables.holidays).select((table) => ({
          name: coalesce(table.name, table.name),
        })),
      );
      expect(await decrypt(row!.name)).toBe("New year");
    });

    test("leaves hand-written SQL as it is stored", async () => {
      await addHoliday();
      const [row] = await queryAll<StoredName>(sql`SELECT name FROM holidays`);
      expect(row!.name.startsWith("enc:")).toBe(true);
    });

    test("passes a column with no codec as it is", async () => {
      expect(
        await encoded(tables.holidays, {
          end_date: "2026-01-02",
        }),
      ).toEqual({ end_date: "2026-01-02" });
    });
  },
);
