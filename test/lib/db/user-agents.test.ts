import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  clearUserAgentLinksForAgent,
  getAgentUserIds,
  getUserAgentIds,
  setAgentUserIds,
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

  test("setAgentUserIds persists the links, ascending", async () => {
    await setAgentUserIds(4, [8, 6, 7]);
    expect(await getAgentUserIds(4)).toEqual([6, 7, 8]);
  });

  test("setAgentUserIds replaces the previous set", async () => {
    await setAgentUserIds(4, [6, 7]);
    await setAgentUserIds(4, [9]);
    expect(await getAgentUserIds(4)).toEqual([9]);
  });

  test("links set from the user side are visible from the agent side", async () => {
    await setUserAgentIds(1, [4, 5]);
    await setUserAgentIds(2, [4]);
    expect(await getAgentUserIds(4)).toEqual([1, 2]);
    expect(await getAgentUserIds(5)).toEqual([1]);
  });
});
