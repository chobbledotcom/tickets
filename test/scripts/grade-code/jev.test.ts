import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { CHECKS } from "#scripts/grade-code/checks.ts";
import { extractCode } from "#scripts/grade-code/extract.ts";
import {
  buildJevState,
  callJev,
  DEFAULT_MODEL,
  gradeJevAnswers,
  loadJevKey,
} from "#scripts/grade-code/jev.ts";

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

  test("treats a key of only spaces as no key", () => {
    expect(
      loadJevKey(
        () => "   ",
        () => "file-key",
      ),
    ).toBe("file-key");
    expect(
      loadJevKey(
        () => undefined,
        () => " \n",
      ),
    ).toBeNull();
  });
});

describe("buildJevState", () => {
  test("carries the facts and the source", () => {
    const facts = extractCode("src/features/a.ts", "// Note.\nconst a = 1;\n");
    const state = buildJevState(facts) as Record<string, unknown>;
    expect(state.file).toBe("src/features/a.ts");
    expect(state.kind).toBe("feature");
    expect(state.lines).toBe(2);
    expect(state.content).toBe("// Note.\nconst a = 1;\n");
    expect(Array.isArray(state.comments)).toBe(true);
    expect(state.standards).toContain("AGENTS.md");
  });

  test("sends the whole source of a long file", () => {
    const source = `const value = "${"x".repeat(60_000)}";\n`;
    const state = buildJevState(extractCode("src/features/a.ts", source));
    expect(state.content).toBe(source);
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
    session: "grade-code-test",
    state: { file: "x" },
  };
  const reply = (status: number, text: string) => () =>
    Promise.resolve({ ok: status === 200, status, text });

  const answered = { q1: { score: 2, type: "score" } };

  test("returns the answers and usage of a good call", async () => {
    const result = await callJev(request, reply(200, okBody(answered)), () =>
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
            : { ok: true, status: 200, text: okBody(answered) },
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

  test("reports a reply that is not JSON as a failed call", async () => {
    const result = await callJev(
      request,
      reply(200, "<html>Bad gateway</html>"),
      () => Promise.resolve(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("the answer is not JSON");
  });

  test("refuses a reply that leaves a question unanswered", async () => {
    const result = await callJev(request, reply(200, okBody({})), () =>
      Promise.resolve(),
    );
    expect(result).toEqual({ error: "no answer for q1", ok: false });
  });

  test("refuses an answer that carries no score", async () => {
    const result = await callJev(
      request,
      reply(200, okBody({ q1: { type: "score" } })),
      () => Promise.resolve(),
    );
    expect(result.ok).toBe(false);
  });

  test("refuses a score or a confidence outside its range", async () => {
    for (const answer of [
      { score: 7, type: "score" },
      { score: -1, type: "score" },
      { confidence: 5, score: 2, type: "score" },
    ]) {
      const result = await callJev(
        request,
        reply(200, okBody({ q1: answer })),
        () => Promise.resolve(),
      );
      expect(result.ok).toBe(false);
    }
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
    expect(sleeps).toEqual([1000, 2000]);
  });

  test("waits only between attempts when every attempt is rate limited", async () => {
    const sleeps: number[] = [];
    const result = await callJev(request, reply(429, "slow down"), (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    });
    expect(result).toEqual({ error: "HTTP 429: slow down", ok: false });
    expect(sleeps).toEqual([5000, 10000]);
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

  test("asks a person to look whenever the model is unsure", () => {
    const results = gradeJevAnswers(
      {
        sureFail: { confidence: 0.9, score: 0, type: "score" },
        surePass: { confidence: 0.9, score: 3, type: "score" },
        unsureFail: { confidence: 0.2, score: 0, type: "score" },
        unsurePass: { confidence: 0.2, score: 3, type: "score" },
      },
      ["surePass", "sureFail", "unsurePass", "unsureFail"].map((id) => ({
        ...check,
        id,
      })),
    );
    expect(results.surePass).toMatchObject({ goodness: 1, status: "PASS" });
    expect(results.sureFail).toMatchObject({ goodness: 0, status: "FAIL" });
    expect(results.unsurePass).toMatchObject({ goodness: 0.5, status: "WARN" });
    expect(results.unsureFail).toMatchObject({ goodness: 0.5, status: "WARN" });
    expect(results.unsurePass?.note).toContain("conf 0.20");
  });

  test("throws when a question it was given has no answer", () => {
    expect(() => gradeJevAnswers({}, [{ ...check, id: "missing" }])).toThrow(
      "Jev returned no answer for missing",
    );
  });

  test("skips a mechanical check that reaches the answer grader", () => {
    const results = gradeJevAnswers({ jev: { score: 3, type: "score" } }, [
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
    session: "grade-code-test",
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
