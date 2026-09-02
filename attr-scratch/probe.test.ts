import { runAll } from "./probe.ts";

Deno.test("probe lines get coverage", () => {
  const r = runAll();
  if (r.a !== 10) throw new Error(String(r.a));
  if (r.b !== "NONEX") throw new Error(r.b);
  if (r.c === false) throw new Error("c");
  if (r.d !== 1) throw new Error(String(r.d));
});
