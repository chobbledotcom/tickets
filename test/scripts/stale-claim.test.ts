import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  claimIsFresh,
  type HeldClaim,
  tryTakeClaim,
  withClaim,
} from "#scripts/stale-claim.ts";
import { withTempDir } from "#test-utils/files.ts";

/** Generous enough that nothing ages out mid-test on a slow machine. */
const FRESH_FOR_MS = 60_000;

/** Touching this rarely means a short test never sees a touch it did not ask for. */
const SETTINGS = { staleMs: FRESH_FOR_MS, touchMs: FRESH_FOR_MS };

const LONG_AGO_MS = Date.now() - 60 * 60 * 1000;

const withClaimDir = <Result>(
  run: (path: string) => Promise<Result>,
): Promise<Result> =>
  withTempDir((dir) => run(join(dir, "job.claim")), {
    prefix: "stale-claim-",
  });

const writeClaim = (path: string, text: string): Promise<void> =>
  Deno.writeTextFile(path, text);

const ageFile = async (path: string, at: number): Promise<void> => {
  const date = new Date(at);
  await Deno.utime(path, date, date);
};

/** Take, then release even if the expectations in `run` fail. */
const withTakenClaim = async (
  path: string,
  run: (claim: HeldClaim) => Promise<void>,
  settings = SETTINGS,
): Promise<void> => {
  const claim = await tryTakeClaim(path, settings);
  expect(claim).not.toBeNull();
  try {
    await run(claim!);
  } finally {
    await claim!.release();
  }
};

describe("taking a claim", () => {
  test("takes a free claim and writes its owner and time", async () => {
    await withClaimDir(async (path) => {
      const before = Date.now();
      await withTakenClaim(path, async (claim) => {
        const [owner, time] = (await Deno.readTextFile(path)).split("\n");
        expect(owner).toBe(claim.owner);
        expect(Number(time)).toBeGreaterThanOrEqual(before);
        expect(Number(time)).toBeLessThanOrEqual(Date.now());
      });
    });
  });

  test("answers null while somebody else's claim is fresh", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, `someone-else\n${Date.now()}`);

      expect(await tryTakeClaim(path, SETTINGS)).toBeNull();
    });
  });

  test("removes and takes over a claim whose owner walked away", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, `someone-else\n${LONG_AGO_MS}`);

      await withTakenClaim(path, async (claim) => {
        expect((await Deno.readTextFile(path)).startsWith(claim.owner)).toBe(
          true,
        );
      });
    });
  });

  test("judges a claim by its file's age when it names no readable time", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, "someone-else\nnot-a-time");
      await ageFile(path, LONG_AGO_MS);

      await withTakenClaim(path, () => Promise.resolve());
    });
  });

  test("leaves a freshly made claim alone while its time is unreadable", async () => {
    await withClaimDir(async (path) => {
      // A taker between creating the file and writing the record: the file is
      // moments old, so it is somebody's claim, not an abandoned one.
      await writeClaim(path, "");

      expect(await tryTakeClaim(path, SETTINGS)).toBeNull();
    });
  });

  test("surfaces a claim file that cannot be made at all", async () => {
    await withClaimDir(async (path) => {
      using _open = stub(Deno, "open", (() =>
        Promise.reject(
          new Deno.errors.PermissionDenied("no access"),
        )) as typeof Deno.open);

      await expect(tryTakeClaim(path, SETTINGS)).rejects.toThrow("no access");
    });
  });

  test("takes the claim when a stale one vanishes during the steal", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, `someone-else\n${LONG_AGO_MS}`);

      const remove = Deno.remove;
      using _remove = stub(Deno, "remove", (async (
        target: string | URL,
        options?: Deno.RemoveOptions,
      ) => {
        // Another taker clears the stale claim first; ours must carry on.
        await remove(target, options).catch(() => {});
        throw new Deno.errors.NotFound("already gone");
      }) as typeof Deno.remove);

      await withTakenClaim(path, () => Promise.resolve());
    });
  });
});

describe("asking whether a claim is fresh", () => {
  test("a missing claim is nobody's", async () => {
    await withClaimDir(async (path) => {
      expect(await claimIsFresh(path, FRESH_FOR_MS)).toBe(false);
    });
  });

  test("a held claim is fresh and a walked-away one is not", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, `someone\n${Date.now()}`);
      expect(await claimIsFresh(path, FRESH_FOR_MS)).toBe(true);

      await writeClaim(path, `someone\n${LONG_AGO_MS}`);
      expect(await claimIsFresh(path, FRESH_FOR_MS)).toBe(false);
    });
  });

  test("a claim from before owners were named is judged by its time", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, String(Date.now()));

      expect(await claimIsFresh(path, FRESH_FOR_MS)).toBe(true);
    });
  });

  test("a disk that cannot be read does not read as nobody's claim", async () => {
    await withClaimDir(async (path) => {
      using _read = stub(Deno, "readTextFile", (() =>
        Promise.reject(
          new Deno.errors.PermissionDenied("no access"),
        )) as typeof Deno.readTextFile);

      await expect(claimIsFresh(path, FRESH_FOR_MS)).rejects.toThrow(
        "no access",
      );
    });
  });
});

describe("keeping a claim fresh while it is held", () => {
  test("touches the claim so it never goes stale mid-work", async () => {
    await withClaimDir(async (path) => {
      await withTakenClaim(
        path,
        async () => {
          // Old enough to be stolen if nothing touched it in time.
          await writeClaim(path, `kept\n${Date.now() - 40}`);
          await new Promise((resolve) => setTimeout(resolve, 30));

          expect(await claimIsFresh(path, 25)).toBe(true);
        },
        { staleMs: 25, touchMs: 5 },
      );
    });
  });

  test("a touch that lands mid-release cannot bring the claim back", async () => {
    await withClaimDir(async (path) => {
      const claim = await tryTakeClaim(path, { staleMs: 60_000, touchMs: 1 });
      // Let at least one touch be queued before the release starts.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await claim!.release();

      await expect(Deno.stat(path)).rejects.toThrow();
    });
  });
});

describe("releasing a claim", () => {
  test("removes the claim so the next taker finds it free", async () => {
    await withClaimDir(async (path) => {
      await withTakenClaim(path, () => Promise.resolve());

      await expect(Deno.stat(path)).rejects.toThrow();
      await withTakenClaim(path, () => Promise.resolve());
    });
  });

  test("leaves a claim that has since become somebody else's", async () => {
    await withClaimDir(async (path) => {
      const claim = await tryTakeClaim(path, SETTINGS);
      await writeClaim(path, `new-owner\n${Date.now()}`);

      await claim!.release();

      expect((await Deno.readTextFile(path)).startsWith("new-owner")).toBe(
        true,
      );
    });
  });

  test("says nothing when the claim is already gone", async () => {
    await withClaimDir(async (path) => {
      const claim = await tryTakeClaim(path, SETTINGS);
      await Deno.remove(path);

      await claim!.release();
    });
  });
});

describe("waiting for a claim", () => {
  test("does the work once the claim's holder lets go, then frees it", async () => {
    await withClaimDir(async (path) => {
      const first = await tryTakeClaim(path, SETTINGS);
      setTimeout(() => void first!.release(), 20);

      const answer = await withClaim(
        path,
        { ...SETTINGS, name: "the test claim", retryMs: 1, timeoutMs: 5_000 },
        () => Promise.resolve("worked"),
      );

      expect(answer).toBe("worked");
      await expect(Deno.stat(path)).rejects.toThrow();
    });
  });

  test("gives up by name when the holder never lets go", async () => {
    await withClaimDir(async (path) => {
      await withTakenClaim(path, async () => {
        let ranAnyway = false;
        await expect(
          withClaim(
            path,
            { ...SETTINGS, name: "the test claim", retryMs: 1, timeoutMs: 20 },
            () => {
              ranAnyway = true;
              return Promise.resolve();
            },
          ),
        ).rejects.toThrow("Timed out waiting for the test claim");
        expect(ranAnyway).toBe(false);
      });
    });
  });
});
