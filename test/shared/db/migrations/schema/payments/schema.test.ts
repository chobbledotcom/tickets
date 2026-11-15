import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { paymentTables } from "#db/migrations/schema/payments/index.ts";
import { sql } from "#db/sql.ts";
import { expectSchemaDeclarationExact } from "#test-utils/db/schema-declaration.ts";
import { describeWithEnv } from "#test-utils/db.ts";

test("keeps the complete payment aggregate schema declaration exact", async () => {
  await expectSchemaDeclarationExact(
    paymentTables,
    "d747ecf9924c30ecbaccd2c4e1f6020fa8bd8931c97975f576a50caf222f4d60",
  );
});

describeWithEnv("db > payment aggregate indexes", { db: true }, () => {
  test("creates every aggregate lookup index", async () => {
    // The declaration hash above pins the index set, so the database only
    // needs to create each declared index and nothing else.
    const declared = paymentTables
      .flatMap(([, table]) => (table.indexes ?? []).map((index) => index.name))
      .sort();
    const result = await getDb().execute(
      sql`SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name IN ('payment_sessions', 'payment_charges', 'payment_cases',
                            'payment_case_decisions', 'payment_completion_effects',
                            'payment_completion_deliveries', 'refund_confirmations',
                            'refund_confirmation_references')
          AND name NOT LIKE 'sqlite_autoindex%'
        ORDER BY name`,
    );
    expect(result.rows.map((row) => row.name)).toEqual(declared);
  });
});
