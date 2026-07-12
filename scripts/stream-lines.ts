import { streamChunks } from "#shared/stream-chunks.ts";

/**
 * Read a byte stream to completion, decoding as UTF-8 and returning the full
 * text. When `onLine` is supplied, each newline-terminated line is delivered as
 * it arrives (with the trailing partial line flushed at the end), so callers can
 * render live progress while still receiving the accumulated text.
 */
export const readStream = async (
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
): Promise<string> => {
  const decoder = new TextDecoder();
  let buffered = "";
  let text = "";

  const flush = (chunk: string, final: boolean): void => {
    text += chunk;
    if (!onLine) return;
    buffered += chunk;
    if (final) {
      if (buffered) onLine(buffered);
      return;
    }
    const lines = buffered.split(/\r?\n/);
    // `split` always yields at least one element, so `pop` is never undefined.
    buffered = lines.pop()!;
    for (const line of lines) onLine(line);
  };

  try {
    for await (const value of streamChunks(stream)) {
      flush(decoder.decode(value, { stream: true }), false);
    }
  } finally {
    flush(decoder.decode(), true);
  }

  return text;
};
