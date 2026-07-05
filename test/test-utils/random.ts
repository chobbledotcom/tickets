import { stub } from "@std/testing/mock";

export const withRandomBytes =
  (bytes: readonly number[]) =>
  <T>(body: () => T): T => {
    const randomStub = stub(
      crypto,
      "getRandomValues",
      <A extends ArrayBufferView | null>(array: A): A => {
        if (array instanceof Uint8Array) {
          for (let i = 0; i < array.length; i++) array[i] = bytes[i] ?? 0;
        }
        return array;
      },
    );
    try {
      return body();
    } finally {
      randomStub.restore();
    }
  };
