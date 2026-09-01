/** Contract only: no provider implementation, network requests or secrets. */
export interface Artist {
  id: string;
  name: string;
  romanName?: string;
  handle?: string;
  instagram?: string;
  sourcePage?: string;
  region?: string;
  school?: string;
  styles?: string[];
  note?: string;
  featured?: boolean;
  huiNote?: string;
  addedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  imageUrl?: string;
  imageAlt?: string;
}

export interface FinderRequest {
  query: string;
  filters?: { region?: string; school?: string; tag?: string };
}

export interface FinderResponse {
  status: "coming-soon" | "ready";
  message: string;
  /** IDs must resolve against the site's repository. Unknown IDs are discarded. */
  artistIds: string[];
}

/** Future server-side provider adapter. The UI never imports a vendor SDK. */
export interface FinderAdapter {
  findArtists(request: FinderRequest, repository: ArtistRepository): Promise<FinderResponse>;
}

export interface ArtistRepository {
  search(request: FinderRequest): Promise<Artist[]>;
  findByIds(ids: string[]): Promise<Artist[]>;
}
