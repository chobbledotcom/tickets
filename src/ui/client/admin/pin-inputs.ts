/// <reference lib="dom" />
/**
 * The Logistics tab's latitude/longitude pin inputs — the one pair the map
 * (logistics-map.ts) watches and the postcode search (address-lookup.ts)
 * fills. Null when the page doesn't carry both.
 */

export type PinInputs = {
  latInput: HTMLInputElement;
  lngInput: HTMLInputElement;
};

export const findPinInputs = (): PinInputs | null => {
  const latInput =
    document.querySelector<HTMLInputElement>('input[name="lat"]');
  const lngInput =
    document.querySelector<HTMLInputElement>('input[name="lng"]');
  return latInput && lngInput ? { latInput, lngInput } : null;
};
