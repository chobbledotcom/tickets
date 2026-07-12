/**
 * Read a byte stream one chunk at a time.
 *
 * Both the storage byte-collector and the line reader walk a
 * `ReadableStream<Uint8Array>` with the same getReader/read/done loop; this
 * holds that loop in one place and hands each chunk out as it arrives. The
 * reader lock is always released, even when the caller stops early or throws.
 */
export async function* streamChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
