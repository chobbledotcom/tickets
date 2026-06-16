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

describe("form stash", () => {
  afterEach(() => clearFormStash());

  test("round-trips a stashed body under its token", () => {
    const token = stashForm("name=Alice&email=a%40b.com");
    expect(token).not.toBeNull();
    expect(takeForm(token!)).toBe("name=Alice&email=a%40b.com");
  });

  test("is one-shot: a token redeems only once", () => {
    const token = stashForm("name=Bob")!;
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
    const token = stashForm(atCap);
    expect(token).not.toBeNull();
    expect(takeForm(token!)).toBe(atCap);
  });

  test("redeems a body any time before the TTL elapses", () => {
    const time = new FakeTime();
    try {
      const token = stashForm("name=Carol")!;
      time.tick(FORM_STASH_TTL_MS - 1);
      expect(takeForm(token)).toBe("name=Carol");
    } finally {
      time.restore();
    }
  });

  test("drops a body once the TTL elapses", () => {
    const time = new FakeTime();
    try {
      const token = stashForm("name=Dave")!;
      time.tick(FORM_STASH_TTL_MS + 1);
      expect(takeForm(token)).toBeNull();
    } finally {
      time.restore();
    }
  });

  test("sweeps expired entries when stashing a new one", () => {
    const time = new FakeTime();
    try {
      const stale = stashForm("name=Old")!;
      time.tick(FORM_STASH_TTL_MS + 1);
      // A fresh stash triggers the eviction sweep that removes the stale entry.
      stashForm("name=New");
      expect(takeForm(stale)).toBeNull();
    } finally {
      time.restore();
    }
  });

  test("evicts the oldest entry once the count cap is exceeded", () => {
    const oldest = stashForm("name=oldest")!;
    for (let i = 0; i < FORM_STASH_MAX_ENTRIES; i++) {
      stashForm(`fill=${i}`);
    }
    expect(takeForm(oldest)).toBeNull();
  });

  test("reports its occupancy and capacity to the cache registry", () => {
    clearFormStash();
    stashForm("name=Eve");
    const stat = getAllCacheStats().find((s) => s.name === "form-stash");
    expect(stat?.entries).toBe(1);
    expect(stat?.capacity).toBe(FORM_STASH_MAX_ENTRIES);
  });
});
