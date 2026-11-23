import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import {
  decideRateContractAction,
  endRateContractAction,
  removeRoomTypeAction,
  saveRateContractAction,
  saveRoomTypeAction,
  setRateLinesAction,
  submitRateContractAction,
  uploadRateContractFileAction,
} from '@/modules/rate-contracts/server/actions';
import { loadRateContract } from '@/modules/rate-contracts/server/queries';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { RateContractNotFound, RateContractPageView, type RateContractActions } from '@/views/rate-contracts/contract-page';
import { rateContractViewerOf } from '../viewer';

export const metadata: Metadata = { title: 'Rate contract' };

const act = (a: unknown) => a as DecisionAction;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One rate contract (Accounts phase 3 contract 9.5 R-E2, screen 15.9): form,
 * rate lines, blackout dates, files, history. rate_contract_get returns null
 * when the viewer may not read it or it does not exist (one answer for both);
 * its `can` block decides which actions show. The database re-checks every
 * command.
 */
export default async function RateContractRoute({ params }: { params: Promise<{ contractId: string }> }) {
  const { contractId } = await params;
  if (!UUID_RE.test(contractId)) return <RateContractNotFound />;
  const staff = await requireStaff();
  const contract = await loadRateContract(staff, contractId).catch(() => 'error' as const);
  if (contract === null) return <RateContractNotFound />;
  const viewer = rateContractViewerOf(staff);
  const actions: RateContractActions =
    contract === 'error'
      ? {}
      : {
          save: contract.can.edit ? act(saveRateContractAction) : null,
          linesSet: contract.can.edit ? act(setRateLinesAction) : null,
          submit: contract.can.submit ? act(submitRateContractAction) : null,
          decide: contract.can.approve || contract.can.return ? act(decideRateContractAction) : null,
          end: contract.can.end ? act(endRateContractAction) : null,
          roomTypeSave: contract.can.edit ? act(saveRoomTypeAction) : null,
          roomTypeRemove: contract.can.edit ? act(removeRoomTypeAction) : null,
          fileUpload: contract.can.upload ? act(uploadRateContractFileAction) : null,
        };
  return (
    <RateContractPageView
      viewer={viewer}
      enabled={contract === 'error' ? true : contract.enabled}
      contract={contract}
      roomTypes={contract === 'error' ? null : contract.roomTypes}
      actions={actions}
      fileHref={(fileId) => `/app/purchase/rate-contracts/files/${fileId}`}
    />
  );
}
