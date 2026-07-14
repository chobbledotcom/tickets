import type { InArgs, InStatement } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { unzipSync, zipSync } from "fflate";
import {
  type BackupManifest,
  createBackupZip,
  PostResetError,
  restoreFromZip,
} from "#shared/db/backup.ts";
import {
  BACKUP_CAPTURE_ATTEMPTS,
  captureBackup,
} from "#shared/db/backup-snapshot.ts";
import { stageCheckout } from "#shared/db/checkout-stages.ts";
import { getDb } from "#shared/db/client.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const stageForBackup = async (sessionId: string): Promise<void> => {
  const listing = await createTestListing({ unitPrice: 1000 });
  await stageCheckout(
    sessionId,
    "stripe",
    checkoutIntent({
      items: [
        checkoutItem({
          listingId: listing.id,
          name: listing.name,
          slug: listing.slug,
        }),
      ],
    }),
  );
};

type BatchStatement = InStatement | [string, InArgs?];

const statementSql = (statement: BatchStatement): string =>
  Array.isArray(statement)
    ? statement[0]
    : typeof statement === "string"
      ? statement
      : statement.sql;

const isRevisionRead = (statements: BatchStatement[]): boolean =>
  statements.some((statement) =>
    statementSql(statement).includes(
      "SELECT revision FROM checkout_stage_revisions",
    ),
  );

const rewriteManifest = (
  zip: Uint8Array,
  change: (manifest: BackupManifest) => void,
): Uint8Array => {
  const files = unzipSync(zip);
  const manifest = JSON.parse(
    decoder.decode(files["manifest.json"]!),
  ) as BackupManifest;
  change(manifest);
  files["manifest.json"] = encoder.encode(JSON.stringify(manifest));
  return zipSync(files);
};

type RevisionReadTracker = { count: number };

const captureWhileStageRevisionChanges = async (
  sessionId: string,
  shouldChange: (revisionReads: number) => boolean,
  tracker: RevisionReadTracker,
): Promise<Awaited<ReturnType<typeof captureBackup>>["tables"]> => {
  await stageForBackup(sessionId);
  const client = getDb();
  const originalBatch = client.batch.bind(client);
  const originalExecute = client.execute.bind(client);
  using _batch = stub(client, "batch", (async (statements, mode) => {
    if (isRevisionRead(statements)) {
      tracker.count += 1;
      if (shouldChange(tracker.count)) {
        await originalExecute(
          "UPDATE checkout_stages SET state = state WHERE payment_session_id = ?",
          [sessionId],
        );
      }
    }
    return await originalBatch(statements, mode);
  }) as typeof client.batch);
  return (await captureBackup()).tables;
};

const stagedBackupWithout = async (
  sessionId: string,
  table: "attendees" | "listing_attendees",
): Promise<Uint8Array> => {
  await stageForBackup(sessionId);
  const files = unzipSync(await createBackupZip());
  const manifest = JSON.parse(
    decoder.decode(files["manifest.json"]!),
  ) as BackupManifest;
  manifest.tables[table] = 0;
  files[`${table}.sql`] = new Uint8Array(0);
  files["manifest.json"] = encoder.encode(JSON.stringify(manifest));
  return zipSync(files);
};

describeWithEnv("db > checkout stage backup snapshots", { db: true }, () => {
  test("puts the stable checkout stage revision in the manifest", async () => {
    await stageForBackup("cs_backup_certificate");

    const files = unzipSync(await createBackupZip());
    const manifest = JSON.parse(
      decoder.decode(files["manifest.json"]!),
    ) as BackupManifest;
    const revision = await getDb().execute(
      "SELECT revision FROM checkout_stage_revisions WHERE id = 1",
    );

    expect(manifest.checkoutStageRevision).toEqual({
      revision: Number(revision.rows[0]!.revision),
    });
  });

  test("pins table discovery and paginated export reads to the primary", async () => {
    await createTestListing({ name: "Primary snapshot" });
    const client = getDb();
    const originalBatch = client.batch.bind(client);
    const backupReadModes: string[] = [];
    using _batch = stub(client, "batch", ((statements, mode) => {
      if (
        statements.some((statement) => {
          const sql = statementSql(statement);
          return (
            sql.includes("sqlite_master") || sql.includes("__backup_rowid__")
          );
        })
      ) {
        backupReadModes.push(String(mode));
      }
      return originalBatch(statements, mode);
    }) as typeof client.batch);

    await captureBackup();

    expect(new Set(backupReadModes)).toEqual(new Set(["write"]));
  });

  test("captures a genuine pre-stage schema without reading a revision", async () => {
    const client = getDb();
    const originalBatch = client.batch.bind(client);
    let revisionReads = 0;
    using _batch = stub(client, "batch", (async (statements, mode) => {
      if (isRevisionRead(statements)) revisionReads += 1;
      const results = await originalBatch(statements, mode);
      if (
        statements.some((statement) =>
          statementSql(statement).includes("sqlite_master"),
        )
      ) {
        results[0]!.rows = results[0]!.rows.filter(
          (row) =>
            row.name !== "checkout_stages" &&
            row.name !== "checkout_stage_revisions",
        );
      }
      return results;
    }) as typeof client.batch);

    const files = unzipSync(await createBackupZip());
    const manifest = JSON.parse(
      decoder.decode(files["manifest.json"]!),
    ) as BackupManifest;

    expect(files["checkout_stages.sql"]).toBeUndefined();
    expect(manifest.checkoutStageRevision).toBeUndefined();
    expect(revisionReads).toBe(0);
  });

  test("retries the whole capture when the stage revision changes", async () => {
    const tracker = { count: 0 };

    await captureWhileStageRevisionChanges(
      "cs_backup_retry",
      (reads) => reads === 2,
      tracker,
    );

    expect(tracker.count).toBe(4);
  });

  test("fails when checkout stages keep changing through every capture", async () => {
    const tracker = { count: 0 };

    await expect(
      captureWhileStageRevisionChanges(
        "cs_backup_never_stable",
        (reads) => reads % 2 === 0,
        tracker,
      ),
    ).rejects.toThrow("Checkout stages kept changing during backup");
    expect(tracker.count).toBe(BACKUP_CAPTURE_ATTEMPTS * 2);
  });

  test("rejects a staged archive without a revision certificate before reset", async () => {
    await stageForBackup("cs_backup_missing_certificate");
    const zip = rewriteManifest(await createBackupZip(), (manifest) => {
      delete manifest.checkoutStageRevision;
    });

    await expect(restoreFromZip(zip)).rejects.toThrow(
      "checkout stage revision certificate",
    );
    const listings = await getDb().execute(
      "SELECT COUNT(*) AS count FROM listings",
    );
    expect(listings.rows[0]!.count).toBe(1);
  });

  test("accepts a genuine backup from before checkout stages existed", async () => {
    const manifest: BackupManifest = {
      latestUpdate: "before checkout stages",
      schemaHash: "pre-stage",
      tables: { settings: 1 },
      timestamp: "2026-07-11T00:00:00.000Z",
    };
    const zip = zipSync({
      "manifest.json": encoder.encode(JSON.stringify(manifest)),
      "settings.sql": encoder.encode(
        "INSERT INTO settings (key, value) VALUES ('pre_stage', 'kept');",
      ),
    });

    await restoreFromZip(zip);

    const restored = await getDb().execute(
      "SELECT value FROM settings WHERE key = 'pre_stage'",
    );
    expect(restored.rows[0]!.value).toBe("kept");
  });

  test("rejects a manifest whose table file is missing before reset", async () => {
    await createTestListing({ name: "Must survive invalid archive" });
    const manifest: BackupManifest = {
      latestUpdate: "old",
      schemaHash: "old",
      tables: { settings: 0 },
      timestamp: "2026-07-11T00:00:00.000Z",
    };
    const zip = zipSync({
      "manifest.json": encoder.encode(JSON.stringify(manifest)),
    });

    await expect(restoreFromZip(zip)).rejects.toThrow(
      "missing table file settings.sql",
    );
    const listings = await getDb().execute(
      "SELECT COUNT(*) AS count FROM listings",
    );
    expect(listings.rows[0]!.count).toBe(1);
  });

  test("rejects a table file absent from its manifest before reset", async () => {
    await createTestListing({ name: "Unlisted file survivor" });
    const manifest: BackupManifest = {
      latestUpdate: "old",
      schemaHash: "old",
      tables: {},
      timestamp: "2026-07-11T00:00:00.000Z",
    };
    const zip = zipSync({
      "listings.sql": new Uint8Array(0),
      "manifest.json": encoder.encode(JSON.stringify(manifest)),
    });

    await expect(restoreFromZip(zip)).rejects.toThrow(
      "listings.sql is absent from its manifest",
    );
    const listings = await getDb().execute(
      "SELECT COUNT(*) AS count FROM listings",
    );
    expect(listings.rows[0]!.count).toBe(1);
  });

  test("rejects a restored row count that differs from the manifest", async () => {
    await createTestListing({ name: "Count mismatch" });
    const zip = rewriteManifest(await createBackupZip(), (manifest) => {
      const count = manifest.tables.listings;
      if (count === undefined)
        throw new Error("Expected listings manifest row");
      manifest.tables.listings = count + 1;
    });

    await expect(restoreFromZip(zip)).rejects.toThrow(PostResetError);
  });

  test("rejects a restored open stage without a booking", async () => {
    await expect(
      restoreFromZip(
        await stagedBackupWithout(
          "cs_backup_missing_booking",
          "listing_attendees",
        ),
      ),
    ).rejects.toThrow(PostResetError);
  });

  test("rejects a restored open stage without its attendee", async () => {
    await expect(
      restoreFromZip(
        await stagedBackupWithout("cs_backup_missing_attendee", "attendees"),
      ),
    ).rejects.toThrow(PostResetError);
  });
});
