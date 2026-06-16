import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  clearUserAgentLinksForAgent,
  getUserAgentIds,
  setUserAgentIds,
} from "#shared/db/user-agents.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db user-agents", { db: true }, () => {
  test("getUserAgentIds returns [] when none assigned", async () => {
    expect(await getUserAgentIds(42)).toEqual([]);
  });

  test("setUserAgentIds persists the links, ascending", async () => {
    await setUserAgentIds(1, [3, 1, 2]);
    expect(await getUserAgentIds(1)).toEqual([1, 2, 3]);
  });

  test("setUserAgentIds dedupes repeated ids", async () => {
    await setUserAgentIds(1, [5, 5, 7]);
    expect(await getUserAgentIds(1)).toEqual([5, 7]);
  });

  test("setUserAgentIds replaces the previous set", async () => {
    await setUserAgentIds(1, [1, 2, 3]);
    await setUserAgentIds(1, [9]);
    expect(await getUserAgentIds(1)).toEqual([9]);
  });

  test("setUserAgentIds with [] clears all links", async () => {
    await setUserAgentIds(1, [1, 2]);
    await setUserAgentIds(1, []);
    expect(await getUserAgentIds(1)).toEqual([]);
  });

  test("links are scoped per user", async () => {
    await setUserAgentIds(1, [1, 2]);
    await setUserAgentIds(2, [2, 3]);
    expect(await getUserAgentIds(1)).toEqual([1, 2]);
    expect(await getUserAgentIds(2)).toEqual([2, 3]);
  });

  test("clearUserAgentLinksForAgent removes that agent from every user", async () => {
    await setUserAgentIds(1, [1, 2]);
    await setUserAgentIds(2, [2, 3]);
    await clearUserAgentLinksForAgent(2);
    expect(await getUserAgentIds(1)).toEqual([1]);
    expect(await getUserAgentIds(2)).toEqual([3]);
  });
});
