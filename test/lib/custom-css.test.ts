import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv, mockRequest } from "#test-utils";

const customCss = (): Promise<Response> =>
  handleRequest(mockRequest("/custom.css"));

describeWithEnv("custom.css handler", { db: true, triggers: true }, () => {
  test("serves an empty text/css body by default", async () => {
    const res = await customCss();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await res.text()).toBe("");
  });

  test("serves the saved custom CSS verbatim", async () => {
    const css = "body { background: rebeccapurple; }";
    await settings.update.customCss(css);
    const res = await customCss();
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).toBe(css);
  });

  test("a non-/custom.css path under the prefix is not handled (404)", async () => {
    const res = await handleRequest(mockRequest("/custom.css/extra"));
    expect(res.status).toBe(404);
  });});
