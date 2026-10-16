/** Images are encrypted at rest, so browsers load them through this route. */
export const getImageProxyUrl = (filename: string): string =>
  `/image/${filename}`;

/** Short-form image references in markdown (`img#7`) resolve through this
 * id-addressed route, which redirects to the canonical proxy URL. */
export const getImageIdProxyUrl = (id: number): string => `/image/id/${id}`;
