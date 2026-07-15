/** Number of UTF-8 bytes used to encode a string. */
export const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).length;
