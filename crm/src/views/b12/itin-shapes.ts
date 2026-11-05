/** Addresses of the itinerary screens (server-safe; B1.2 Phase F). */
export function itineraryHref(documentId: string): string {
  return `/app/itineraries/${documentId}`;
}
export function itineraryPreviewHref(documentId: string): string {
  return `/app/itineraries/${documentId}/preview`;
}
