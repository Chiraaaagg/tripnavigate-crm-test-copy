import { z } from 'zod';
import {
  SMALL_BALANCE_PRESETS,
  WRITE_OFF_DIRECTIONS,
  WRITE_OFF_STATUSES,
  type WriteOffCommandResult,
  type WriteOffSwitchResult,
} from './contracts';

/**
 * Read DTOs of the write-off reads (contract 6.6: R-B1 small_balances_list,
 * R-B2 write_off_monthly, the writeOff block of deal_dues). Every key listed
 * (strict objects): a reply with any other key fails closed. No customer
 * contact, receipts, PAN or names beyond the staff names the contract lists.
 * Money is whole paise as decimal strings. Pure.
 */

const paise = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));

export const SmallBalanceWriteOffSchema = z
  .object({
    id: z.uuid(),
    refNo: z.string().regex(/^WO-[0-9]{4}-[0-9]{6}$/),
    status: z.enum(WRITE_OFF_STATUSES),
    amountPaise: paise,
    reason: z.string(),
    proposedByName: z.string().nullable(),
    rowVersion: z.number().int().positive(),
  })
  .strict();
export type SmallBalanceWriteOff = z.infer<typeof SmallBalanceWriteOffSchema>;

export const SmallBalanceRowSchema = z
  .object({
    dealId: z.uuid(),
    dealReference: z.string(),
    branchName: z.string(),
    tripEnd: isoDate.nullable(),
    direction: z.enum(WRITE_OFF_DIRECTIONS),
    /** The whole current balance (due) or credit (excess): what a write-off must equal. */
    balancePaise: paise,
    limitPaise: paise,
    writeOff: SmallBalanceWriteOffSchema.nullable(),
    /** WRITE_OFF_BLOCK_CODES; an unknown code from a newer server is kept (generic words). */
    blockedBy: z.array(z.string().regex(/^[a-z_]{1,40}$/)),
    can: z
      .object({ propose: z.boolean(), approve: z.boolean(), return: z.boolean(), withdraw: z.boolean(), undo: z.boolean() })
      .strict(),
  })
  .strict();
export type SmallBalanceRow = z.infer<typeof SmallBalanceRowSchema>;

export const SmallBalancesPageSchema = z
  .object({
    items: z.array(SmallBalanceRowSchema),
    /** Keyset cursor "YYYY-MM-DD|<dealId>" (trip end, Deal); null = that is all. */
    nextAfter: z.string().regex(/^\d{4}-\d{2}-\d{2}\|[0-9a-f-]{36}$/).nullable(),
    hasMore: z.boolean().optional(),
    /** 20261205000240: the write-off switch and limit in the caller's scope. */
    settings: z.object({ enabled: z.boolean(), limitPaise: paise }).strict().optional(),
  })
  .strict();
export type SmallBalancesPage = z.infer<typeof SmallBalancesPageSchema>;

export interface SmallBalancesFilter {
  preset?: (typeof SMALL_BALANCE_PRESETS)[number];
  branchId?: string;
  dealReference?: string;
}

export const WriteOffMonthlySchema = z
  .object({
    month: isoDate,
    branches: z.array(
      z.object({ branchName: z.string(), count: z.number().int().nonnegative(), duePaise: paise, excessPaise: paise }).strict(),
    ),
  })
  .strict();
export type WriteOffMonthly = z.infer<typeof WriteOffMonthlySchema>;

/** The writeOff block of deal_dues (contract 6.6): the active write-off (proposed or approved), else null. */
export const DuesWriteOffSchema = z
  .object({
    refNo: z.string().regex(/^WO-[0-9]{4}-[0-9]{6}$/),
    direction: z.enum(WRITE_OFF_DIRECTIONS),
    amountPaise: paise,
    status: z.enum(WRITE_OFF_STATUSES),
    reason: z.string(),
    proposedByName: z.string().nullable(),
    decidedByName: z.string().nullable(),
    decidedAt: timestamp.nullable(),
  })
  .strict();
export type DuesWriteOff = z.infer<typeof DuesWriteOffSchema>;

/**
 * The two keys deal_dues adds (patch for the accounts-desk dues DTO, applied
 * by track C's owner through the lead): `writeOff` and `writeOffNeedsReview`.
 */
export const DuesWriteOffKeysSchema = z
  .object({ writeOff: DuesWriteOffSchema.nullable(), writeOffNeedsReview: z.boolean() })
  .strict();
export type DuesWriteOffKeys = z.infer<typeof DuesWriteOffKeysSchema>;

export const WriteOffCommandResultSchema = z
  .object({
    outcome: z.enum(['created', 'updated', 'existing']),
    writeOffId: z.uuid(),
    dealId: z.uuid(),
    refNo: z.string().regex(/^WO-[0-9]{4}-[0-9]{6}$/),
    direction: z.enum(WRITE_OFF_DIRECTIONS),
    status: z.enum(WRITE_OFF_STATUSES),
    amountPaise: paise,
    rowVersion: z.number().int().positive(),
  })
  .strict() satisfies z.ZodType<WriteOffCommandResult>;

export const WriteOffSwitchResultSchema = z
  .object({
    changed: z.boolean(),
    writeOffEnabled: z.boolean(),
    writeOffLimitPaise: paise,
    rowVersion: z.number().int().nonnegative(),
    updatedAt: z.string().nullable(),
  })
  .strict() satisfies z.ZodType<WriteOffSwitchResult>;
