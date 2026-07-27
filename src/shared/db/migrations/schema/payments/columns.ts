export const MAX_PAYMENT_INTEGER = Number.MAX_SAFE_INTEGER;

export const encryptedPaymentColumnOrNull = (column: string): string =>
  `(${column} IS NULL OR ${column} LIKE 'enc:1:%')`;
