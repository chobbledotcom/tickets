export interface SpecRegistry {
  actors: readonly string[];
  editions: readonly string[];
  owners: readonly string[];
  risks: readonly string[];
  surfaces: readonly string[];
}

export interface SpecSource {
  data: string;
  uri: string;
}

export interface SpecItem {
  id: string;
  line: number;
  name: string;
  surfaces: string[];
}

export interface SpecRule extends SpecItem {
  cases: SpecItem[];
  description: string;
}

export interface SpecStory extends SpecItem {
  actors: string[];
  description: string;
  editions: string[];
  owner: string;
  risk: string;
  rules: SpecRule[];
  uri: string;
}

export interface SpecCatalog {
  ndjson: string;
  stories: SpecStory[];
}
