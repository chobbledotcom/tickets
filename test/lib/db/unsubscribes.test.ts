import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getUnsubscribedHashSet,
  hashEmail,
  isHashUnsubscribed,
  resubscribeHash,
  unsubscribeHash,
} from "#shared/db/unsubscribes.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("unsubscribes db", { db: true }, () => {
  test("hashEmail normalizes case and surrounding whitespace", async () => {
    const a = await hashEmail("Bob@Example.com");
    const b = await hashEmail("  bob@example.com ");
    expect(a).toBe(b);
  });

  test("hashEmail distinguishes different addresses", async () => {
    const a = await hashEmail("a@example.com");
    const b = await hashEmail("b@example.com");
    expect(a).not.toBe(b);
  });

  test("an address is subscribed (not unsubscribed) by default", async () => {
    const hash = await hashEmail("new@example.com");
    expect(await isHashUnsubscribed(hash)).toBe(false);
  });

  test("unsubscribeHash marks the hash as unsubscribed", async () => {
    const hash = await hashEmail("leaver@example.com");
    await unsubscribeHash(hash);
    expect(await isHashUnsubscribed(hash)).toBe(true);
  });

  test("unsubscribeHash is idempotent", async () => {
    const hash = await hashEmail("twice@example.com");
    await unsubscribeHash(hash);
    await unsubscribeHash(hash);
    expect(await isHashUnsubscribed(hash)).toBe(true);
  });

  test("resubscribeHash removes the hash", async () => {
    const hash = await hashEmail("returner@example.com");
    await unsubscribeHash(hash);
    await resubscribeHash(hash);
    expect(await isHashUnsubscribed(hash)).toBe(false);
  });

  test("resubscribeHash is a no-op when not unsubscribed", async () => {
    const hash = await hashEmail("never@example.com");
    await resubscribeHash(hash);
    expect(await isHashUnsubscribed(hash)).toBe(false);
  });

  test("getUnsubscribedHashSet returns all unsubscribed hashes", async () => {
    const one = await hashEmail("one@example.com");
    const two = await hashEmail("two@example.com");
    await unsubscribeHash(one);
    await unsubscribeHash(two);

    const set = await getUnsubscribedHashSet();

    expect(set.has(one)).toBe(true);
    expect(set.has(two)).toBe(true);
    expect(set.has(await hashEmail("three@example.com"))).toBe(false);
  });
});
