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

/** Stub crypto.getRandomValues to deal each call the next counter value as a
 * 16-bit draw, so id-shape tests pin their ids deterministically instead of
 * riding on a lucky random draw. */
export const withCountedRandomWords = <T>(body: () => T): T => {
  let draw = 0;
  const counted = stub(
    crypto,
    "getRandomValues",
    <A extends ArrayBufferView | null>(array: A): A => {
      if (array instanceof Uint8Array) {
        draw += 1;
        new DataView(array.buffer).setUint16(0, draw);
      }
      return array;
    },
  );
  try {
    return body();
  } finally {
    counted.restore();
  }
};
