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

export interface SpecCase {
  id: string;
  line: number;
  name: string;
}

export interface SpecRule {
  cases: SpecCase[];
  description: string;
  id: string;
  line: number;
  name: string;
}

export interface SpecStory {
  actors: string[];
  description: string;
  editions: string[];
  id: string;
  line: number;
  name: string;
  owner: string;
  risk: string;
  rules: SpecRule[];
  uri: string;
}

export interface SpecCatalog {
  ndjson: string;
  stories: SpecStory[];
}
