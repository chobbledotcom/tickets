export const bearerAuthorization = (token: string): string => `Bearer ${token}`;

export const bearerTokenOrNull = (
  authorization: string | null,
): string | null => {
  if (authorization === null) return null;
  return /^Bearer ([^\s]+)$/i.exec(authorization)?.[1] ?? null;
};
