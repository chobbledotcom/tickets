import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { onceSuccessful } from "#shared/once-successful.ts";

test("onceSuccessful shares success but retries a failed attempt", async () => {
  let calls = 0;
  const load = onceSuccessful(() => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error("temporary failure"))
      : Promise.resolve("ready");
  });

  const first = load();
  expect(load()).toBe(first);
  await expect(first).rejects.toThrow("temporary failure");
  expect(await load()).toBe("ready");
  expect(await load()).toBe("ready");
  expect(calls).toBe(2);
});

test("onceSuccessful keeps a retry started by an early rejection handler", async () => {
  const first = Promise.withResolvers<string>();
  let calls = 0;
  const load = onceSuccessful(() => {
    calls += 1;
    return calls === 1 ? first.promise : Promise.resolve("ready");
  });

  const failed = load();
  const retry = failed.catch(() => load());
  const sharedFailure = load();
  first.reject(new Error("temporary failure"));
  await Promise.allSettled([failed, retry, sharedFailure]);

  expect(await load()).toBe("ready");
  expect(calls).toBe(2);
});
