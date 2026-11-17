import { Card, CardBody } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { TallyFilesList } from './files';
import { MakeTallyFilePanel } from './make-file';
import { TallyMatchUpload } from './match-upload';
import type { TallyFileHeader } from './types';

/*
 * The Phase 3 blocks of Accounts › Tally, in page order: "Make Tally file",
 * "Files made" and "Upload Tally vouchers". UX redesign R4 (D11): TallyPage
 * (views/accounts-desk/tally.tsx) shows them only while the Tally file
 * method is the one shown; the CSV export has its own tab.
 */

export interface TallyFileModel {
  /** accounts_settings.tally_xml_enabled of the entity. */
  enabled: boolean;
  companyName: string | null;
  entities: Array<{ id: string; name: string }>;
  branches: Array<{ id: string; name: string }>;
  files: TallyFileHeader[] | 'error';
}

export interface TallyFileActions {
  preview: DecisionAction;
  create: DecisionAction;
  stageMatch: DecisionAction;
}

export function TallyFileSections({
  model,
  actions,
  initial,
}: {
  model: TallyFileModel;
  actions: TallyFileActions;
  /** Preview gallery: start states. */
  initial?: { preview?: DeskResult | null; create?: DeskResult | null; match?: DeskResult | null; includeAgain?: boolean };
}) {
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardBody>
          <MakeTallyFilePanel
            enabled={model.enabled}
            companyName={model.companyName}
            entities={model.entities}
            branches={model.branches}
            previewAction={actions.preview}
            createAction={actions.create}
            initialPreview={initial?.preview ?? null}
            initialState={initial?.create ?? null}
            initialIncludeAgain={initial?.includeAgain}
          />
        </CardBody>
      </Card>
      <TallyFilesList files={model.files} />
      <Card>
        <CardBody>
          <TallyMatchUpload entityId={model.entities[0]?.id ?? ''} action={actions.stageMatch} initialState={initial?.match ?? null} />
        </CardBody>
      </Card>
    </div>
  );
}

/** Accounts › Tally for someone who is not Accounts (contract 14: Tally is Accounts only). */
export function TallyFileNoAccess() {
  return (
    <div className="font-sans">
      <PageHeader title="Tally" />
      <Notice tone="restricted" title="For Accounts only">
        <p>The Tally file, the left-out list and the voucher upload are used by Accounts.</p>
      </Notice>
    </div>
  );
}
