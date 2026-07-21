import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readStream } from "#scripts/stream-lines.ts";

const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return ReadableStream.from(chunks.map((chunk) => encoder.encode(chunk)));
};

describe("readStream", () => {
  test("returns the full text and delivers each line, flushing the tail", async () => {
    const lines: string[] = [];
    const text = await readStream(streamOf("a\nb", "c\nd"), (line) =>
      lines.push(line),
    );

    expect(text).toBe("a\nbc\nd");
    // "b" and "c" arrive in separate chunks but belong to one line.
    expect(lines).toEqual(["a", "bc", "d"]);
  });

  test("accumulates text without a line callback", async () => {
    const text = await readStream(streamOf("hello ", "world"));
    expect(text).toBe("hello world");
  });

  test("does not emit a trailing empty line when input ends in a newline", async () => {
    const lines: string[] = [];
    await readStream(streamOf("x\n"), (line) => lines.push(line));
    expect(lines).toEqual(["x"]);
  });
});
