export const isAllowedEvidenceRequest = (
  baseUrl: string,
  requestUrl: string,
): boolean => {
  const url = new URL(requestUrl);
  return url.origin === new URL(baseUrl).origin || url.protocol === "data:";
};
