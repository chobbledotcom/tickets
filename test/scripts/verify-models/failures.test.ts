import { createClient } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { attendeeCapacityModelData } from "#scripts/verify-models/attendee-capacity.ts";

test("capacity proof extraction propagates an unexpected batch error", async () => {
  const client = createClient({ url: ":memory:" });
  const prototype = Object.getPrototypeOf(client);
  client.close();
  const failure = new Error("Unexpected probe failure.");
  using _batch = stub(prototype, "batch", () => Promise.reject(failure));
  await expect(attendeeCapacityModelData()).rejects.toBe(failure);
});
