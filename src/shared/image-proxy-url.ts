/** Images are encrypted at rest, so browsers load them through this route. */
export const getImageProxyUrl = (filename: string): string =>
  `/image/${filename}`;
