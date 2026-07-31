export interface FetchTextResult {
  ok: boolean;
  status: number;
  text: string;
}

export type FetchText = (
  url: string,
  init: RequestInit,
) => Promise<FetchTextResult>;

export const fetchText: FetchText = async (url, init) => {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
  };
};
