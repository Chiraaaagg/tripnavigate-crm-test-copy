/*
 * Shapes for the supplier register, the supplier page and the quote hotel
 * picker (Accounts phase 2 contract 5.1–5.7 R-A1..R-A3, 13.4; Addendum L2:
 * kind values `direct` | `channel`): track A's DTOs, re-exported type-only
 * (no zod, no runtime import, so client components stay CSP-safe), plus the
 * hotel list search shape the pickers take.
 */

export type {
  HotelSupplierOption,
  QuoteCatalogueHotel,
  SupplierBankState,
  SupplierChangeSource,
  SupplierContactView,
  SupplierDuplicate,
  SupplierDuplicateReason,
  SupplierHistoryRow,
  SupplierHotelLinkView,
  SupplierHotelSource,
  SupplierKind,
  SupplierMaster,
  SupplierPrimaryContact,
  SupplierRegisterFilter,
  SupplierRegisterPage,
  SupplierRegisterRow,
  SupplierServiceType,
  SupplierStatus,
  SupplierVerification,
  SupplierViewer,
} from '@/modules/suppliers/contracts';

/** Hotel catalogue search result (same shape as the booking form's HotelOption). */
export interface CatalogueHotelOption {
  hotelId: string;
  name: string;
  city: string;
  area: string | null;
  category: string | null;
}

export type CatalogueHotelSearch = (query: string) => Promise<{ ok: true; items: CatalogueHotelOption[]; more: boolean } | { ok: false; message: string }>;
