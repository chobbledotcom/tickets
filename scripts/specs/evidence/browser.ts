export const resolveEvidencePath = (
  template: string,
  values: ReadonlyMap<string, string>,
): string =>
  template.replaceAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, name: string) => {
    const value = values.get(name);
    if (value === undefined) {
      throw new Error(`Evidence World value ${name} was not set`);
    }
    return encodeURIComponent(value);
  });

export const isAllowedEvidenceRequest = (
  baseUrl: string,
  requestUrl: string,
): boolean => {
  const url = new URL(requestUrl);
  return url.origin === new URL(baseUrl).origin || url.protocol === "data:";
};
