import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { getAllCacheStats } from "#shared/cache-registry.ts";
import { clearFormStash, stashForm, takeForm } from "#shared/form-stash.ts";
import {
  FORM_STASH_MAX_BYTES,
  FORM_STASH_MAX_ENTRIES,
  FORM_STASH_TTL_MS,
} from "#shared/limits.ts";
import { times } from "#test-utils";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const stashRequired = (data: string): string => {
  const token = stashForm(data);
  if (token === null) throw new Error(`Expected ${data} to be stashed`);
  expect(token).toMatch(TOKEN_PATTERN);
  return token;
};

const formStashStat = () => {
  const stat = getAllCacheStats().find((s) => s.name === "form-stash");
  if (stat === undefined) {
    throw new Error("form-stash stats are not registered");
  }
  return stat;
};

const withTimedStash =
  (data: string) =>
  (elapsedMs: number) =>
  <T>(body: (token: string) => T): T => {
    const time = new FakeTime();
    try {
      const token = stashRequired(data);
      time.tick(elapsedMs);
      return body(token);
    } finally {
      time.restore();
    }
  };

const stashIndexedBodies =
  (field: string) =>
  (count: number): string[] =>
    times(count)((i) => stashRequired(`${field}=${i}`));

const fillToCountCap = (): string[] => {
  const tokens = stashIndexedBodies("fill")(FORM_STASH_MAX_ENTRIES);
  expect(formStashStat().entries).toBe(FORM_STASH_MAX_ENTRIES);
  return tokens;
};

describe("form stash", () => {
  afterEach(() => clearFormStash());

  test("round-trips a stashed body under its token", () => {
    const token = stashRequired("name=Alice&email=a%40b.com");
    expect(takeForm(token)).toBe("name=Alice&email=a%40b.com");
  });

  test("uses unique URL-safe tokens for separate stashed bodies", () => {
    const first = stashRequired("name=Alice");
    const second = stashRequired("name=Alison");
    expect(first).not.toBe(second);
    expect(takeForm(first)).toBe("name=Alice");
    expect(takeForm(second)).toBe("name=Alison");
  });

  test("is one-shot: a token redeems only once", () => {
    const token = stashRequired("name=Bob");
    expect(takeForm(token)).toBe("name=Bob");
    expect(takeForm(token)).toBeNull();
  });

  test("returns null for an unknown token", () => {
    expect(takeForm("never-stashed")).toBeNull();
  });

  test("refuses to stash an empty body", () => {
    expect(stashForm("")).toBeNull();
  });

  test("refuses to stash a body larger than the cap", () => {
    expect(stashForm("x".repeat(FORM_STASH_MAX_BYTES + 1))).toBeNull();
  });

  test("stashes a body exactly at the size cap", () => {
    const atCap = "x".repeat(FORM_STASH_MAX_BYTES);
    const token = stashRequired(atCap);
    expect(takeForm(token)).toBe(atCap);
  });

  test("redeems a body any time before the TTL elapses", () => {
    withTimedStash("name=Carol")(FORM_STASH_TTL_MS - 1)((token) => {
      expect(takeForm(token)).toBe("name=Carol");
    });
  });

  test("drops a body once the TTL elapses", () => {
    withTimedStash("name=Dave")(FORM_STASH_TTL_MS + 1)((token) => {
      expect(takeForm(token)).toBeNull();
    });
  });

  test("sweeps expired entries when stashing a new one", () => {
    withTimedStash("name=Old")(FORM_STASH_TTL_MS + 1)((stale) => {
      // A fresh stash triggers the eviction sweep that removes the stale entry.
      const fresh = stashRequired("name=New");
      expect(formStashStat().entries).toBe(1);
      expect(takeForm(stale)).toBeNull();
      expect(takeForm(fresh)).toBe("name=New");
    });
  });

  test("preserves unexpired entries when sweeping before a new stash", () => {
    withTimedStash("name=Warm")(FORM_STASH_TTL_MS - 1)((existing) => {
      const fresh = stashRequired("name=Fresh");
      expect(formStashStat().entries).toBe(2);
      expect(takeForm(existing)).toBe("name=Warm");
      expect(takeForm(fresh)).toBe("name=Fresh");
    });
  });

  test("does not evict entries while filling exactly to the count cap", () => {
    const tokens = fillToCountCap();
    expect(takeForm(tokens[0]!)).toBe("fill=0");
    expect(takeForm(tokens.at(-1)!)).toBe(`fill=${FORM_STASH_MAX_ENTRIES - 1}`);
  });

  test("evicts exactly the oldest entry once the count cap is exceeded", () => {
    const tokens = fillToCountCap();
    const overflow = stashRequired("overflow=1");
    expect(formStashStat().entries).toBe(FORM_STASH_MAX_ENTRIES);
    expect(takeForm(tokens[0]!)).toBeNull();
    expect(takeForm(tokens[1]!)).toBe("fill=1");
    expect(takeForm(overflow)).toBe("overflow=1");
  });

  test("reports its occupancy and capacity to the cache registry", () => {
    clearFormStash();
    stashRequired("name=Eve");
    expect(formStashStat()).toEqual({
      capacity: FORM_STASH_MAX_ENTRIES,
      entries: 1,
      name: "form-stash",
    });
  });
});
