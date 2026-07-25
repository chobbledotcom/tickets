export const invalidSpec = (
  uri: string,
  line: number,
  message: string,
): never => {
  throw new Error(`${uri}:${line}: ${message}`);
};
