import type { ResultSet } from "@libsql/client";
import { assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { builtSites, insertBuiltSite } from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { renewalUrlFor, rotateRenewalToken } from "#shared/site-renewal.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { statementSql, wrapDbClient } from "#test-utils/record-queries.ts";

describeWithEnv("renewal token rotation", { db: true }, () => {
  test("out-of-order responses leave the stored token on the site", async () => {
    await insertBuiltSite(
      "Rotate Site",
      "rotate.test.net",
      "",
      "",
      true,
      "7001",
    );
    const site = (await builtSites.getAll())[0]!;

    // Two concurrent rotations. The provider applies pushes in call order —
    // so the site ends up serving the SECOND URL — but the first request's
    // response arrives last, the shape a real edge race produces.
    const hostedUrls: string[] = [];
    const firstPush = Promise.withResolvers<{ ok: true }>();
    const pushStub: Stub = stub(
      bunnyCdnApi,
      "setEdgeScriptSecret",
      (_scriptId: number, _name: string, value: string) => {
        hostedUrls.push(value);
        if (hostedUrls.length === 1) return firstPush.promise;
        return Promise.resolve({ ok: true as const });
      },
    );

    const rotations = Promise.all([
      rotateRenewalToken(site, "test rotation"),
      rotateRenewalToken(site, "test rotation"),
    ]);
    // The first push's response arrives only after the SECOND rotation's
    // persist has landed — the first rotation then persists over it, which
    // is the out-of-order shape the race produces. A serialized rotation
    // queues the second behind the first, so the fallback releases the
    // response once the pushes have plainly settled.
    const secondPersistLanded = Promise.withResolvers<void>();
    const restoreDb = wrapDbClient({
      batch: () => undefined,
      execute: (statement): Promise<ResultSet> | null => {
        if (statementSql(statement).includes("renewal_token_index")) {
          secondPersistLanded.resolve();
          restoreDb();
        }
        return null;
      },
    });
    const fallback = setTimeout(() => secondPersistLanded.resolve(), 50);
    // Real one-shot fallback, deliberately: the thing under test is an
    // out-of-order CDN response, which a serialized rotation never produces —
    // the hook above cannot fire there, so no fake timer can drive this.
    try {
      await secondPersistLanded.promise;
    } finally {
      clearTimeout(fallback);
    }
    firstPush.resolve({ ok: true });
    await rotations;
    pushStub.restore();

    const stored = (await builtSites.getAll()).find((s) => s.id === site.id)!;
    // The link the stored token resolves must be the one the site serves —
    // a stored token whose URL an out-of-order response overwrote is dead.
    expect(renewalUrlFor(stored.renewalToken!)).toBe(
      hostedUrls[hostedUrls.length - 1],
    );
  });

  test("a rotation that dies mid-flight does not block the queue behind it", async () => {
    await insertBuiltSite(
      "Crash Rotate",
      "crash-rotate.test",
      "",
      "",
      false,
      "7002",
    );
    const site = (await builtSites.getAll()).find(
      ({ name }) => name === "Crash Rotate",
    )!;

    // The first rotation's push throws — the raw provider-failure shape no
    // error result wraps — so its promise rejects and the queue must survive.
    let failedOnce = false;
    const pushedUrls: string[] = [];
    const pushStub: Stub = stub(
      bunnyCdnApi,
      "setEdgeScriptSecret",
      (
        _scriptId: number,
        _name: string,
        value: string,
      ): Promise<{ ok: true }> => {
        if (!failedOnce) {
          failedOnce = true;
          throw new Error("edge script API died");
        }
        pushedUrls.push(value);
        return Promise.resolve({ ok: true as const });
      },
    );

    const first = rotateRenewalToken(site, "First rotation failed");
    const second = rotateRenewalToken(site, "Second rotation failed");
    await assertRejects(() => first, Error, "edge script API died");
    const pushed = await second;
    pushStub.restore();

    expect(pushed).toBe(true);
    const stored = (await builtSites.getAll()).find((s) => s.id === site.id)!;
    // The surviving rotation's token is the one the row keeps.
    expect(pushedUrls.at(-1)).toBe(renewalUrlFor(stored.renewalToken!));
  });
});
