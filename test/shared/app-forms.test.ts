import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { OWNER_FORM } from "#routes/auth.ts";
import { createOrderedCollectionHandlers } from "#shared/app-forms.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

type Params = { id: number };

describeWithEnv("app form handlers", { db: true }, () => {
  const request = async (): Promise<Request> =>
    mockFormRequest(
      "/admin/things/2/move",
      { csrf_token: await testCsrfToken() },
      await testCookie(),
    );

  const setup = () => {
    const swaps: [number, number][] = [];
    const handlers = createOrderedCollectionHandlers({
      auth: OWNER_FORM,
      keys: () => Promise.resolve([1, 2, 3]),
      loadContext: ({ id }: Params) =>
        Promise.resolve(id === 99 ? null : { id }),
      movedMessage: "Thing moved",
      redirectPath: ({ context }) => `/admin/things/${context.id}`,
      swap: (first, second) => {
        swaps.push([first, second]);
        return Promise.resolve();
      },
      target: ({ context }) => context.id,
    });
    return { handlers, swaps };
  };

  test("moves an item up by swapping it with its previous neighbour", async () => {
    const { handlers, swaps } = setup();
    const response = await handlers.up(await request(), { id: 2 });

    expect(swaps).toEqual([[2, 1]]);
    expect(response.headers.get("location")).toBe("/admin/things/2?flash=");
  });

  test("moves an item down by swapping it with its next neighbour", async () => {
    const { handlers, swaps } = setup();
    await handlers.down(await request(), { id: 2 });

    expect(swaps).toEqual([[2, 3]]);
  });

  test("does not swap an item beyond the collection boundary", async () => {
    const { handlers, swaps } = setup();
    await handlers.up(await request(), { id: 1 });

    expect(swaps).toEqual([]);
  });

  test("returns 404 when the ordered item context is missing", async () => {
    const { handlers, swaps } = setup();
    const response = await handlers.up(await request(), { id: 99 });

    expect(response.status).toBe(404);
    expect(swaps).toEqual([]);
  });
});
