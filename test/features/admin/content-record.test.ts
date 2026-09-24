import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { contentRecordPage } from "#routes/admin/content-record.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { getTestSession } from "#test-utils/session.ts";

describeWithEnv("content record gate", { db: true }, () => {
  /** One content-gated request with a signed-in session cookie. */
  const gatedRequest = async (): Promise<Request> => {
    const { cookie } = await getTestSession();
    return new Request("http://localhost/admin/example/1", {
      headers: { cookie },
    });
  };

  test("a falsy record that is not null reaches the page body", async () => {
    const seen: boolean[] = [];
    const response = await contentRecordPage<boolean>(
      await gatedRequest(),
      1,
      () => Promise.resolve(false),
      async (record) => {
        seen.push(record);
        return new Response("page", { status: 200 });
      },
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual([false]);
  });

  test("a null load answers 404", async () => {
    const response = await contentRecordPage<object>(
      await gatedRequest(),
      1,
      () => Promise.resolve(null),
      async () => new Response("page", { status: 200 }),
    );
    expect(response.status).toBe(404);
  });
});
