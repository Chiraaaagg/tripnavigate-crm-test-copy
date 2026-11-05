import {
  acknowledgeItineraryDifferenceAction,
  checkItineraryDifferencesAction,
  createItineraryAction,
  markItineraryReadyAction,
  removeItinerarySourceAction,
  requestItineraryRenderAction,
  saveItineraryFactsAction,
  uploadItinerarySourceAction,
  useItineraryBasisValueAction,
} from '@/modules/itineraries/server/actions';
import type { ItinActions } from '@/views/b12/itin-kit';

/** The server actions behind the itinerary screens (Terra, terra-b12-itineraries-handoff §2 and §4). */
export const ITINERARY_ACTIONS: ItinActions = {
  create: createItineraryAction,
  uploadSource: uploadItinerarySourceAction,
  removeSource: removeItinerarySourceAction,
  saveFacts: saveItineraryFactsAction,
  checkDifferences: checkItineraryDifferencesAction,
  useBasisValue: useItineraryBasisValueAction,
  acknowledge: acknowledgeItineraryDifferenceAction,
  markReady: markItineraryReadyAction,
  requestRender: requestItineraryRenderAction,
};
