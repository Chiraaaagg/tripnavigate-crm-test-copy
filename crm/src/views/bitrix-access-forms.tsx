'use client';

import { useActionState, useId, useMemo, useState } from 'react';
import { FormMessage } from '@/components/FormMessage';
import { SubmitButton } from '@/components/SubmitButton';
import { initialFormState } from '@/lib/forms';
import { HandForm } from '@/components/hand-form';
import { addStaffFromBitrixAction, linkBitrixUserAction, unlinkBitrixUserAction } from '@/modules/integration/server/access-actions';
import type { BitrixUser } from '@/modules/integration/bitrix/directory';
import type { Option } from './admin-forms';
import { useFormStateSavedKey } from './keep-form-values';

/*
 * Batch 4 (lead ruling): these forms submit by hand (shared HandForm), so a
 * refusal keeps every choice on screen (React would otherwise reset the
 * selects to their first value). After a success the form is remounted
 * (useFormStateSavedKey) so it starts empty for the next person.
 */

/** Search box + native select: type part of a name or email to narrow the list. */
function BitrixUserPicker({ users, name, label }: { users: BitrixUser[]; name: string; label: string }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? users.filter((u) => `${u.name} ${u.email ?? ''} ${u.id}`.toLowerCase().includes(q)) : users;
    return list.slice(0, 200);
  }, [users, query]);
  return (
    <div className="field">
      <label htmlFor={`${id}-q`}>Search {label.toLowerCase()}</label>
      <input
        id={`${id}-q`}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Name or email"
        autoComplete="off"
      />
      <label htmlFor={`${id}-s`}>{label}</label>
      <select id={`${id}-s`} name={name} required defaultValue="" key={query}>
        <option value="" disabled>
          {shown.length === 0 ? 'No match' : `Choose (${shown.length} shown)`}
        </option>
        {shown.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
            {u.email ? ` <${u.email}>` : ''}
            {u.active ? '' : ' (inactive in Bitrix)'}
          </option>
        ))}
      </select>
    </div>
  );
}

export function AddStaffFromBitrixForm({ users, branches, roles }: { users: BitrixUser[]; branches: Option[]; roles: Option[] }) {
  const [state, action] = useActionState(addStaffFromBitrixAction, initialFormState);
  const savedKey = useFormStateSavedKey(state);
  return (
    <HandForm key={savedKey} action={action} noValidate>
      <FormMessage state={state} />
      <div className="panel-grid">
        <BitrixUserPicker users={users} name="bitrixUserId" label="Bitrix user" />
        <div className="field">
          <label htmlFor="bx-branch">Branch</label>
          <select id="bx-branch" name="branchId" required defaultValue="">
            <option value="" disabled>
              Choose a branch
            </option>
            {branches.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="bx-role">Role</label>
          <select id="bx-role" name="roleCode" required defaultValue="sales">
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <SubmitButton pendingLabel="Inviting…">Invite and link to Bitrix</SubmitButton>
    </HandForm>
  );
}

/** Per staff member: link (grant their Bitrix deals) or unlink (revoke). */
export function BitrixLinkCell({
  userId,
  name,
  linked,
  users,
}: {
  userId: string;
  name: string;
  /** Linked Bitrix user, if any. */
  linked: { id: string; name: string } | null;
  users: BitrixUser[] | null;
}) {
  const [linkState, link] = useActionState(linkBitrixUserAction, initialFormState);
  const [unlinkState, unlink] = useActionState(unlinkBitrixUserAction, initialFormState);
  if (linked) {
    return (
      <HandForm action={unlink} noValidate className="inline-form">
        <FormMessage state={unlinkState} />
        <span>
          {linked.name} <span className="hint">(#{linked.id})</span>
        </span>
        <input type="hidden" name="userId" value={userId} />
        <SubmitButton pendingLabel="Removing access…" variant="secondary">
          Unlink<span className="visually-hidden"> {name} from Bitrix</span>
        </SubmitButton>
      </HandForm>
    );
  }
  if (!users) return <span className="hint">Not linked (Bitrix user list unavailable)</span>;
  return (
    <details className="staff-actions">
      <summary>
        Link Bitrix user<span className="visually-hidden"> for {name}</span>
      </summary>
      <HandForm action={link} noValidate className="action-block">
        <FormMessage state={linkState} />
        <input type="hidden" name="userId" value={userId} />
        <BitrixUserPicker users={users} name="bitrixUserId" label="Bitrix user" />
        <p className="hint">Their Bitrix deals become theirs at once; new ones follow automatically.</p>
        <SubmitButton pendingLabel="Linking…">Link and give access</SubmitButton>
      </HandForm>
    </details>
  );
}
