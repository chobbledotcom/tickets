import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { orderedListRoutes } from "#shared/ordered-list-routes.ts";
import { ORDERED_LISTS } from "#shared/ordered-lists.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

const ROW_PATH = "/admin/settings/statuses/:id";

describeWithEnv("ordered list routes", { db: true }, () => {
  /** Move one status of three beside the anchor, through routes built on a
   *  store that holds them in memory. Hands back the response and every
   *  order the store was asked to keep. */
  const moved = async (
    place: "after" | "before",
    id: number,
    anchor: string,
    rows: readonly { id: number }[] | null = [{ id: 1 }, { id: 2 }, { id: 3 }],
  ) => {
    const stored: number[][] = [];
    const routes = orderedListRoutes(ORDERED_LISTS.status, {
      arrange: (arranged) => {
        stored.push(arranged.map((row) => row.id));
        return Promise.resolve();
      },
      rows: () => rows,
    });
    const request = mockFormRequest(
      `/admin/settings/statuses/${id}/move-${place}`,
      { anchor, csrfToken: await testCsrfToken() },
      await testCookie(),
    );
    const response = await routes[`POST ${ROW_PATH}/move-${place}`](request, {
      id,
    });
    return { response, stored };
  };

  test("stores the order with the row before its anchor", async () => {
    const { response, stored } = await moved("before", 3, "1");

    expect(stored).toEqual([[3, 1, 2]]);
    expect(response.headers.get("location")).toMatch(
      /^\/admin\/settings\/statuses\?flash=/,
    );
    expectFlash(response, "Status moved", true);
  });

  test("stores the order with the row after its anchor", async () => {
    expect((await moved("after", 1, "2")).stored).toEqual([[2, 1, 3]]);
  });

  for (const [title, anchor] of [
    ["is gone", "7"],
    ["is the row itself", "2"],
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

  for (const [title, id, rows] of [
    ["the row is not in the list", 99, undefined],
    ["the list is gone", 1, null],
  ] as const) {
    test(`returns 404 when ${title}`, async () => {
      const { response, stored } = await moved("before", id, "2", rows);

      expect([response.status, stored]).toEqual([404, []]);
    });
  }
});
