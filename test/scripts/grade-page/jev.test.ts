import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { CHECKS } from "#scripts/grade-page/checks.ts";
import { extractPage } from "#scripts/grade-page/extract.ts";
import {
  buildJevState,
  callJev,
  DEFAULT_MODEL,
  gradeJevAnswers,
  loadJevKey,
  MAX_CONTENT_CHARS,
} from "#scripts/grade-page/jev.ts";

const jevCheck = (id: string) => {
  const found = CHECKS.find((check) => check.id === id);
  if (found === undefined) throw new Error(`no check called ${id}`);
  return found;
};

describe("loadJevKey", () => {
  test("takes the environment key first", () => {
    expect(
      loadJevKey(
        () => "env-key ",
        () => "file-key",
      ),
    ).toBe("env-key");
  });

  test("falls to the secret file when the environment is empty", () => {
    expect(
      loadJevKey(
        () => "",
        () => " file-key",
      ),
    ).toBe("file-key");
    expect(
      loadJevKey(
        () => undefined,
        () => "file-key",
      ),
    ).toBe("file-key");
    expect(
      loadJevKey(
        () => undefined,
        () => null,
      ),
    ).toBeNull();
  });
});

describe("buildJevState", () => {
  test("carries the facts and the trimmed source", () => {
    const facts = extractPage("src/features/a.ts", "// Note.\nconst a = 1;\n");
    const state = buildJevState(facts) as Record<string, unknown>;
    expect(state.file).toBe("src/features/a.ts");
    expect(state.kind).toBe("feature");
    expect(state.lines).toBe(2);
    expect(state.content).toBe("// Note.\nconst a = 1;\n");
    expect(state.content_truncated).toBe(false);
    expect(Array.isArray(state.comments)).toBe(true);
    expect(state.standards).toContain("AGENTS.md");
  });

  test("caps the source and says so", () => {
    const source = `const value = "${"x".repeat(MAX_CONTENT_CHARS)}";\n`;
    const facts = extractPage("src/features/a.ts", source);
    const state = buildJevState(facts) as Record<string, unknown>;
    expect(String(state.content).length).toBe(MAX_CONTENT_CHARS);
    expect(state.content_truncated).toBe(true);
  });
});

const okBody = (answers: unknown) =>
  JSON.stringify({
    answers,
    model: "jev-test",
    usage: { input_tokens: 11, output_tokens: 7 },
  });

describe("callJev", () => {
  const request = {
    apiKey: "key",
    model: DEFAULT_MODEL,
    questions: { q1: { type: "score" } },
    session: "grade-page-test",
    state: { file: "x" },
  };
  const reply = (status: number, text: string) => () =>
    Promise.resolve({ ok: status === 200, status, text });

  test("returns the answers and usage of a good call", async () => {
    const result = await callJev(request, reply(200, okBody({})), () =>
      Promise.resolve(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage.model).toBe("jev-test");
      expect(result.usage.inputTokens).toBe(11);
    }
  });

  test("retries a rate limit until it succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await callJev(
      request,
      () => {
        calls++;
        return Promise.resolve(
          calls === 1
            ? { ok: false, status: 429, text: "slow down" }
            : { ok: true, status: 200, text: okBody({}) },
        );
      },
      (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    );
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([5000]);
  });

  test("stops at once when the answer cannot be paid for", async () => {
    let calls = 0;
    const result = await callJev(
      request,
      () => {
        calls++;
        return Promise.resolve({ ok: false, status: 402, text: "no credits" });
      },
      () => Promise.resolve(),
    );
    expect(result).toEqual({ error: "HTTP 402: no credits", ok: false });
    expect(calls).toBe(1);
  });

  test("refuses a response in the wrong shape", async () => {
    const result = await callJev(request, reply(200, '{"model": 5}'), () =>
      Promise.resolve(),
    );
    expect(result.ok).toBe(false);
  });

  test("retries a network failure and reports it", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await callJev(
      request,
      () => {
        calls++;
        return Promise.reject(new TypeError("fetch failed"));
      },
      (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    );
    expect(result.ok).toBe(false);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 1001, 1002]);
  });
});

describe("gradeJevAnswers", () => {
  const check = jevCheck("comments_earn_place");

  test("grades a score into pass, warn, and fail", () => {
    const results = gradeJevAnswers(
      {
        high: { score: 2.5, type: "score" },
        low: { score: 0.2, type: "score" },
        mid: { score: 1.5, type: "score" },
      },
      [
        { ...check, id: "high" },
        { ...check, id: "mid" },
        { ...check, id: "low" },
      ],
    );
    expect(results.high?.status).toBe("PASS");
    expect(results.mid?.status).toBe("WARN");
    expect(results.low?.status).toBe("FAIL");
    expect(results.low?.note).toBe("score=0.20");
  });

  test("downgrades a fail the model is unsure about", () => {
    const results = gradeJevAnswers(
      { unsure: { confidence: 0.2, score: 0, type: "score" } },
      [{ ...check, id: "unsure" }],
    );
    expect(results.unsure?.status).toBe("WARN");
    expect(results.unsure?.note).toContain("conf 0.20");
  });

  test("marks an answer that claims a score but carries none", () => {
    const results = gradeJevAnswers({ empty: { type: "score" } }, [
      { ...check, id: "empty" },
    ]);
    expect(results.empty?.status).toBe("WARN");
    expect(results.empty?.note).toContain("no score");
  });

  test("skips a mechanical check that reaches the answer grader", () => {
    const results = gradeJevAnswers({}, [
      { ...check, engine: "code" },
      { ...check, id: "jev" },
    ]);
    expect(Object.keys(results)).toEqual(["jev"]);
  });
});

describe("callJev usage fallbacks", () => {
  const request = {
    apiKey: "key",
    model: "jev-1.13",
    questions: {},
    session: "grade-page-test",
    state: {},
  };

  test("names the request's model when the reply carries none", async () => {
    const result = await callJev(
      request,
      () => Promise.resolve({ ok: true, status: 200, text: '{"answers":{}}' }),
      () => Promise.resolve(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.usage.model).toBe("jev-1.13");
  });

  test("reports a network failure that is not an Error", async () => {
    const result = await callJev(
      request,
      () => Promise.reject("socket closed"),
      () => Promise.resolve(),
    );
    expect(result).toEqual({ error: "socket closed", ok: false });
  });
});
