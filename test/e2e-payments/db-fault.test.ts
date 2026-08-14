/**
 * Direct tests for the scoped Money fault: a real libsql database with a
 * transfers table, exactly as the live Stripe fault scenario installs it.
 */

import { createClient } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  REFUSE_REFUND_TRANSFERS_TRIGGER,
  refuseRefundTransfers,
} from "#e2e/db-fault.ts";

const TRANSFERS_TABLE = `
  CREATE TABLE transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    amount INTEGER NOT NULL
  )
`;

const insertTransfer = async (url: string, kind: string): Promise<void> => {
  const client = createClient({ url });
  try {
    await client.execute({
      args: [kind, 100],
      sql: "INSERT INTO transfers (kind, amount) VALUES (?, ?)",
    });
  } finally {
    client.close();
  }
};

const kindsIn = async (url: string): Promise<string[]> => {
  const client = createClient({ url });
  try {
    const rows = await client.execute("SELECT kind FROM transfers ORDER BY id");
    return rows.rows.map((row) => String(row.kind ?? ""));
  } finally {
    client.close();
  }
};

/** A fresh file database with a transfers table, removed after the body runs. */
const withTransfersDb = async (
  body: (dbUrl: string) => Promise<void>,
): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "e2e-fault-" });
  try {
    const dbUrl = `file:${dir}/fault-test.db`;
    const setup = createClient({ url: dbUrl });
    try {
      await setup.execute(TRANSFERS_TABLE);
    } finally {
      setup.close();
    }
    await body(dbUrl);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

/** Assert a write is refused with a message matching `pattern`. */
const expectRefused = async (
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> => {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(pattern);
    return;
  }
  throw new Error("expected the write to be refused, but it succeeded");
};

describe("the scoped refund-transfer refusal fault", () => {
  it("refuses refund legs but leaves sales alone", async () => {
    await withTransfersDb(async (dbUrl) => {
      await insertTransfer(dbUrl, "sale");
      const fault = await refuseRefundTransfers({ dbUrl });

      await expectRefused(
        insertTransfer(dbUrl, "refund_cash"),
        /refund ledger unavailable/,
      );
      // Fee and modifier refund legs are refused too — every refund_ prefix.
      await expectRefused(insertTransfer(dbUrl, "refund_fee"), /unavailable/);
      await expectRefused(
        insertTransfer(dbUrl, "refund_modifier"),
        /unavailable/,
      );

      await fault.remove();
      await insertTransfer(dbUrl, "refund_cash");

      expect(await kindsIn(dbUrl)).toEqual(["sale", "refund_cash"]);
    });
  });

  it("drops its named trigger and is safe to remove twice", async () => {
    await withTransfersDb(async (dbUrl) => {
      const fault = await refuseRefundTransfers({ dbUrl });
      await fault.remove();
      // The second remove must neither throw nor disturb the database.
      await fault.remove();

      const check = createClient({ url: dbUrl });
      try {
        const triggers = await check.execute(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?",
          [REFUSE_REFUND_TRANSFERS_TRIGGER],
        );
        expect(triggers.rows).toEqual([]);
      } finally {
        check.close();
      }
      // Removal really restored refund writes.
      await insertTransfer(dbUrl, "refund_cash");
      expect(await kindsIn(dbUrl)).toEqual(["refund_cash"]);
    });
  });
});
