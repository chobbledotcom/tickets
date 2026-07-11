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
