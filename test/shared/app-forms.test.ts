import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { OWNER_FORM } from "#routes/auth.ts";
import { createOrderedCollectionHandlers } from "#shared/app-forms.ts";
import type { MovePlace } from "#shared/reorder.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

type Params = { id: number };

describeWithEnv("app form handlers", { db: true }, () => {
  const request = async (anchor: string): Promise<Request> =>
    mockFormRequest(
      "/admin/things/2/move",
      { anchor, csrfToken: await testCsrfToken() },
      await testCookie(),
    );

  /** Move one item beside the anchor, and hand back the response and every
   *  order the handler stored. */
  const moved = async (place: MovePlace, id: number, anchor: string) => {
    const stored: (readonly number[])[] = [];
    const handlers = createOrderedCollectionHandlers({
      arrange: (keys) => {
        stored.push(keys);
        return Promise.resolve();
      },
      auth: OWNER_FORM,
      keys: () => Promise.resolve([1, 2, 3]),
      loadContext: ({ id }: Params) =>
        Promise.resolve(id === 99 ? null : { id }),
      movedMessage: "Thing moved",
      redirectPath: ({ context }) => `/admin/things/${context.id}`,
      target: ({ context }) => context.id,
    });
    const response = await handlers[place](await request(anchor), { id });
    return { response, stored };
  };

  test("stores the order with the item before its anchor", async () => {
    const { response, stored } = await moved("before", 3, "1");

    expect(stored).toEqual([[3, 1, 2]]);
    expect(response.headers.get("location")).toBe("/admin/things/3?flash=");
    expectFlash(response, "Thing moved", true);
  });

  test("stores the order with the item after its anchor", async () => {
    expect((await moved("after", 1, "2")).stored).toEqual([[2, 1, 3]]);
  });

  for (const [title, anchor] of [
    ["is gone", "7"],
    ["is the item itself", "2"],
    ["is blank", ""],
  ] as const) {
    test(`stores nothing and says the list changed when the anchor ${title}`, async () => {
      const { response, stored } = await moved("after", 2, anchor);

      expect(stored).toEqual([]);
      expectFlash(
        response,
        "That list changed since you opened it. Please try the move again.",
        false,
      );
    });
  }

  test("returns 404 when the ordered item context is missing", async () => {
    const { response, stored } = await moved("before", 99, "1");

    expect(response.status).toBe(404);
    expect(stored).toEqual([]);
  });
});
