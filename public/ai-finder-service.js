/* Provider-neutral boundary. Intentionally offline; does not issue requests. */
(function (root) {
  const service = {
    async findArtists(_request) {
      return { status: "coming-soon", message: "", artistIds: [] };
    },
    resolveArtists(response, artists) {
      return root.ArtistIndex.resolveIds(response?.artistIds, artists);
    }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = service;
  else root.ArtistFinderService = Object.freeze(service);
})(typeof window !== "undefined" ? window : this);
