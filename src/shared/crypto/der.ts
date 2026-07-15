/** Small DER reader and writer for RSA keys, X.509 certificates, and CMS. */

export interface DerValue {
  contents: Uint8Array;
  encoded: Uint8Array;
  tag: number;
}

export const joinBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

export const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

const unsignedBytes = (value: number): number[] => {
  const bytes: number[] = [];
  for (
    let remaining = value;
    remaining > 0;
    remaining = Math.floor(remaining / 256)
  ) {
    bytes.unshift(remaining & 0xff);
  }
  return bytes;
};

const encodeLength = (length: number): Uint8Array => {
  if (length < 128) return new Uint8Array([length]);
  const bytes = unsignedBytes(length);
  return new Uint8Array([0x80 + bytes.length, ...bytes]);
};

export const encodeDer = (
  tag: number,
  parts: readonly Uint8Array[],
): Uint8Array => {
  if (
    !Number.isInteger(tag) ||
    tag === 0 ||
    tag >>> 8 !== 0 ||
    (tag & 0x1f) === 0x1f
  ) {
    throw new Error(`Unsupported DER tag: ${tag}`);
  }
  const contents = joinBytes(parts);
  return joinBytes([
    new Uint8Array([tag]),
    encodeLength(contents.length),
    contents,
  ]);
};

export const encodeSequence = (parts: readonly Uint8Array[]): Uint8Array =>
  encodeDer(0x30, parts);

const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};

export const sortDerValues = (values: readonly Uint8Array[]): Uint8Array[] =>
  values.toSorted(compareBytes);

export const encodeSet = (values: readonly Uint8Array[]): Uint8Array =>
  encodeDer(0x31, sortDerValues(values));

export const encodeInteger = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid DER integer: ${value}`);
  }
  const bytes = unsignedBytes(value);
  if (bytes.length === 0 || bytes[0]! >= 0x80) bytes.unshift(0);
  return encodeDer(0x02, [new Uint8Array(bytes)]);
};

const encodeBase128 = (value: bigint): number[] => {
  const bytes = [Number(value & 0x7fn)];
  for (let remaining = value >> 7n; remaining > 0; remaining >>= 7n) {
    bytes.unshift(Number(remaining & 0x7fn) + 0x80);
  }
  return bytes;
};

export const encodeOid = (value: string): Uint8Array => {
  const [firstText, secondText, ...restText] = value.split(".");
  if (
    !firstText ||
    !secondText ||
    ![firstText, secondText, ...restText].every((arc) => /^\d+$/.test(arc))
  ) {
    throw new Error(`Invalid OID: ${value}`);
  }
  const first = BigInt(firstText);
  const second = BigInt(secondText);
  if (first > 2n || (first < 2n && second > 39n)) {
    throw new Error(`Invalid OID: ${value}`);
  }
  const body = [
    ...encodeBase128(first * 40n + second),
    ...restText.map(BigInt).flatMap(encodeBase128),
  ];
  return encodeDer(0x06, [new Uint8Array(body)]);
};

export const encodeOctetString = (value: Uint8Array): Uint8Array =>
  encodeDer(0x04, [value]);

export const encodeNull = (): Uint8Array => encodeDer(0x05, []);

const twoDigits = (value: number): string =>
  value < 10 ? `0${value}` : String(value);

export const encodeTime = (value: Date): Uint8Array => {
  const year = value.getUTCFullYear();
  const rest = `${twoDigits(value.getUTCMonth() + 1)}${twoDigits(value.getUTCDate())}${twoDigits(value.getUTCHours())}${twoDigits(value.getUTCMinutes())}${twoDigits(value.getUTCSeconds())}Z`;
  const encoded = new TextEncoder().encode(
    year >= 1950 && year <= 2049
      ? `${String(year).substring(2)}${rest}`
      : `${year}${rest}`,
  );
  return encodeDer(year >= 1950 && year <= 2049 ? 0x17 : 0x18, [encoded]);
};

interface ReadResult {
  end: number;
  value: DerValue;
}

interface DecodedLength {
  contentStart: number;
  length: number;
}

const decodeLongLength = (
  bytes: Uint8Array,
  contentStart: number,
  count: number,
): DecodedLength => {
  if (count === 0) throw new Error("Indefinite DER length is forbidden");
  const lengthEnd = contentStart + count;
  if (count > 3 || lengthEnd > bytes.length) {
    throw new Error("Invalid DER length");
  }
  if (bytes[contentStart] === 0) throw new Error("Non-minimal DER length");
  let length = 0;
  for (let index = 0; index < count; index++) {
    length = length * 256 + bytes[contentStart + index]!;
  }
  if (length < 128) throw new Error("Non-minimal DER length");
  return { contentStart: lengthEnd, length };
};

const decodeLength = (
  bytes: Uint8Array,
  offset: number,
  firstLength: number,
): DecodedLength =>
  firstLength < 0x80
    ? { contentStart: offset + 2, length: firstLength }
    : decodeLongLength(bytes, offset + 2, firstLength & 0x7f);

const readAt = (bytes: Uint8Array, offset: number): ReadResult => {
  const tag = bytes[offset];
  const firstLength = bytes[offset + 1];
  if (tag === undefined || firstLength === undefined) {
    throw new Error("Truncated DER value");
  }
  if (tag === 0) throw new Error("DER end-of-contents tag is forbidden");
  if ((tag & 0x1f) === 0x1f)
    throw new Error("High-number DER tags are unsupported");
  const { contentStart, length } = decodeLength(bytes, offset, firstLength);
  const end = contentStart + length;
  if (end > bytes.length) throw new Error("DER value exceeds its container");
  return {
    end,
    value: {
      contents: bytes.subarray(contentStart, end),
      encoded: bytes.subarray(offset, end),
      tag,
    },
  };
};

export const readDer = (bytes: Uint8Array): DerValue => {
  const result = readAt(bytes, 0);
  if (result.end !== bytes.length)
    throw new Error("Trailing bytes after DER value");
  return result.value;
};

export const readDerChildren = (parent: DerValue): DerValue[] => {
  const children: DerValue[] = [];
  for (let offset = 0; offset < parent.contents.length; ) {
    const result = readAt(parent.contents, offset);
    children.push(result.value);
    offset = result.end;
  }
  return children;
};

export const readDerSequence = (bytes: Uint8Array, label: string): DerValue[] =>
  readDerChildren(requireDerTag(readDer(bytes), 0x30, label));

export const requireDerTag = (
  value: DerValue,
  tag: number,
  label: string,
): DerValue => {
  if (value.tag !== tag) throw new Error(`Invalid ${label}`);
  return value;
};
