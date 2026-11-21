import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createApi } from "#test/blackbox/api.ts";
import { createApp, inProcess, type Target } from "#test/blackbox/driver.ts";
import { openApi } from "#test/blackbox/seed.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** A target that records each request and answers with `text`. */
const recording = (text: string, status = 200) => {
  const requests: Request[] = [];
  const target: Target = (request) => {
    requests.push(request);
    return Promise.resolve(new Response(text, { status }));
  };
  return { requests, target };
};

describe("createApi", () => {
  test("sends the key with every request, and JSON only when there is a body", async () => {
    const { requests, target } = recording('{"ok":true}');
    const api = createApi(target, "k1");
    await api.get("/api/admin/listings");
    await api.post("/api/admin/listings", { name: "A" });
    expect(
      requests.map((request) => request.headers.get("authorization")),
    ).toEqual(["Bearer k1", "Bearer k1"]);
    expect(
      requests.map((request) => request.headers.get("content-type")),
    ).toEqual([null, "application/json"]);
    expect(await requests[1]!.text()).toBe('{"name":"A"}');
  });

  test("uses the method that each call names", async () => {
    const { requests, target } = recording("{}");
    const api = createApi(target, "k1");
    await api.put("/p", { a: 1 });
    await api.delete("/d", { confirm_identifier: "x" });
    await api.delete("/d2");
    expect(requests.map((request) => request.method)).toEqual([
      "PUT",
      "DELETE",
      "DELETE",
    ]);
    expect(await requests[1]!.text()).toBe('{"confirm_identifier":"x"}');
    expect(await requests[2]!.text()).toBe("");
  });

  test("answers with the status and the parsed body", async () => {
    const { target } = recording('{"error":"no"}', 400);
    expect(await createApi(target, "k1").get("/x")).toEqual({
      body: { error: "no" },
      status: 400,
    });
  });

  test("reads an empty answer as null", async () => {
    const { target } = recording("");
    expect(await createApi(target, "k1").get("/x")).toEqual({
      body: null,
      status: 200,
    });
  });

  test("fails and shows the text when the answer is not JSON", async () => {
    const { target } = recording("<html>oops</html>", 502);
    await expect(createApi(target, "k1").get("/x")).rejects.toThrow(
      "The API answered /x with text that is not JSON: <html>oops</html>",
    );
  });
});

describeWithEnv("admin API against the app", { db: true }, () => {
  test("refuses a key that the owner never made", async () => {
    const answer = await createApi(inProcess, "not-a-key").get(
      "/api/admin/listings",
    );
    expect(answer.status).toBe(401);
  });

  test("answers a key that the owner made on the keys page", async () => {
    const owner = createApp(inProcess);
    await owner.logIn();
    const answer = await (await openApi(owner)).get("/api/admin/listings");
    expect(answer.status).toBe(200);
  });
});
