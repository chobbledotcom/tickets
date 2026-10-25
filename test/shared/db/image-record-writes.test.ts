import type { InStatement, InValue } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#db/client.ts";
import {
  deleteImageRecord,
  getImageById,
  imageUrlsFor,
  insertImageRecord,
  updateImageRecord,
} from "#db/images.ts";
import { getCurrentSettingsVersion } from "#db/settings.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { createTestDbWithSetup, describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > image record writes", { db: true }, () => {
  test("advance the shared version when an insert, an update, and a delete land", async () => {
    // The shared version is the counter other isolates read, so every
    // record write must move it in the same transaction as the row change.
    const before = await getCurrentSettingsVersion();

    const image = await insertImageRecord({
      altText: "Bump alt",
      filename: nonEmptyString("bump.webp"),
      filenameThumb: nonEmptyString("bump-thumb.webp"),
      name: "Bump",
    });
    const afterInsert = await getCurrentSettingsVersion();

    expect(image.name).toBe("Bump");
    expect(afterInsert).toBeGreaterThan(before);

    const updated = await updateImageRecord(image.id, { name: "Bump two" });
    const afterUpdate = await getCurrentSettingsVersion();

    expect(updated?.name).toBe("Bump two");
    expect(afterUpdate).toBeGreaterThan(afterInsert);

    await deleteImageRecord(image.id);
    const afterDelete = await getCurrentSettingsVersion();

    expect(await getImageById(image.id)).toBeNull();
    expect(afterDelete).toBeGreaterThan(afterUpdate);
  });

  test("a fresh test database does not inherit the image-URL cache", async () => {
    // The next describeWithEnv test gets a fresh copy of the same golden
    // state: the same settings version, but its own images rows. This
    // database's insert does not move the version (only the record spine
    // does), so the cache this lookup fills carries the version the fresh
    // copy also holds. The URL must still not cross that boundary.
    const image = await makeImage("Carry");
    const text = `![Carry](img#${image.id})`;

    const warm = await imageUrlsFor([text]);
    expect(warm.get(image.id)).toBe(`/image/${image.filename}`);

    await createTestDbWithSetup();

    const carried = await imageUrlsFor([text]);
    expect(carried.get(image.id)).toBeUndefined();
  });

  test("refuse an update that names no column", async () => {
    // An empty partial cannot build an UPDATE: the statement takes its SET
    // clause from the provided columns alone. Refuse it with a clear error
    // instead of a database syntax error.
    const image = await makeImage("Empty Update");

    await expect(updateImageRecord(image.id, {})).rejects.toThrow(
      "names no column to write",
    );
  });

  test("looks up exactly the ids the texts reference", async () => {
    // The images write above clears the cache through the table hook, so
    // the lookup starts cold with no warm answers.
    await makeImage("LookupGuard");
    // img#0 sits below the first autoincrement id and must not reach the
    // lookup's id list. img#2 must reach it even when no row carries it.
    const db = getDb();
    const realExecute = db.execute.bind(db);
    const ran: InStatement[] = [];
    const executeStub = stub(db, "execute", (stmt: InStatement) => {
      ran.push(stmt);
      return realExecute(stmt);
    });
    try {
      await imageUrlsFor(["![a](img#0) ![b](img#2)"]);
    } finally {
      executeStub.restore();
    }
    const imageReads = ran.filter(
      (stmt): stmt is { sql: string; args: InValue[] } =>
        typeof stmt !== "string" && stmt.sql.includes("FROM images"),
    );
    expect(imageReads).toEqual([
      { args: [2], sql: expect.stringContaining("id IN (?)") },
    ]);
  });
});
