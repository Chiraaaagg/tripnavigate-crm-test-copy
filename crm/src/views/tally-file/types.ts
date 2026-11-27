/*
 * Types of the Tally import file and the matching upload (Accounts phase 3,
 * contract 7; reads R-C1..R-C4, commands C1, C3–C6). Track C's DTOs in
 * `@/modules/accounts-desk/contracts` are the source; the screens import them
 * from here so the preview gallery and the routes share one shape. Money is
 * paise as decimal strings. Accounts only (contract 14).
 */

export {
  LEFT_OUT_REASONS,
  MATCH_OUTCOMES,
  TALLY_FILE_KINDS,
  TF_FIELD,
  type LeftOutReason,
  type MatchBatchStatus,
  type MatchOutcome,
  type TallyAnyKind,
  type TallyFileCreated,
  type TallyFileHeader,
  type TallyFileKind,
  type TallyFileLine,
  type TallyFilePreview,
  type TallyLeftOutPage,
  type TallyLeftOutRow,
  type TallyMatchApplied,
  type TallyMatchBatch,
  type TallyMatchPage,
  type TallyMatchRow,
  type TallyPartyName,
} from '@/modules/accounts-desk/contracts';
