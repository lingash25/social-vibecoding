'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { changeHref } from '../../lib/change-href';

// Approvals (#admin/approvals, #6643).
//
// Changes held for an admin (src/services/release-holds.js): a change that
// trips one of that module's rules does not go live until a full admin other
// than its author votes yes on it. This screen lists the ones still waiting,
// oldest first, and what became of the ones before them, read from
// GET /api/admin/release-holds.
//
// Nothing is decided here. An admin answers by voting on the change itself,
// with the same buttons as everyone else: their yes lifts the hold, their no
// closes the change and its request. So the screen is read only and open to
// every admin, and each row is a link to the change.

type Outcome = 'waiting' | 'approved' | 'declined' | 'fixed' | 'closed' | 'notice';

interface Hold {
  id: number;
  sessionId: number;
  appSlug: string;
  appName: string;
  title: string;
  prNumber: number | null;
  author: string | null;
  rules: string[];
  reasons: string[];
  outcome: Outcome;
  note: string | null;
  decidedBy: string | null;
  heldAt: string | null;
  decidedAt: string | null;
  needsAnotherAdmin: boolean;
}

export interface ApprovalsPayload {
  waiting: Hold[];
  history: Hold[];
  rules: { key: string; words: string }[];
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  waiting: 'Waiting',
  approved: 'Approved',
  declined: 'Declined',
  fixed: 'No longer needed',
  closed: 'Closed first',
  notice: 'Told, not held',
};

const OUTCOME_BADGE: Record<Outcome, string> = {
  waiting: AdminUI.badge.warn,
  approved: AdminUI.badge.success,
  declined: AdminUI.badge.outline,
  fixed: AdminUI.badge.secondary,
  closed: AdminUI.badge.secondary,
  notice: AdminUI.badge.secondary,
};

function when(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** How long a hold has waited, in the largest whole unit. */
export function waited(iso: string | null, now: number = Date.now()): string {
  const at = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

function ChangeCell({ hold }: { hold: Hold }) {
  return (
    <>
      {/* Built from the row's own slug, session id and PR number, never from a URL the API handed over. */}
      <a className={AdminUI.btn.link} href={changeHref(hold.appSlug, hold.sessionId, hold.prNumber)}>
        {hold.prNumber != null ? `#${hold.prNumber} ` : ''}{hold.title || 'Untitled change'}
      </a>
      <div className={`${AdminUI.muted} text-xs`}>
        {hold.appName || 'Unknown project'}{hold.author ? ` · by @${hold.author}` : ''}
      </div>
    </>
  );
}

function Reasons({ hold }: { hold: Hold }) {
  return (
    <ul className="list-none m-0 p-0">
      {hold.reasons.map((reason) => <li key={reason}>{reason}</li>)}
    </ul>
  );
}

export function ApprovalsView({ payload, tab, onTab, now }: {
  payload: ApprovalsPayload | null;
  tab: 'waiting' | 'history';
  onTab: (t: 'waiting' | 'history') => void;
  now?: number;
}) {
  const waiting = payload?.waiting || [];
  const history = payload?.history || [];
  return (
    <div className={`${AdminUI.card} p-4`}>
      <div className={AdminUI.cardHeader}>
        <h2 className={AdminUI.cardTitle}>Approvals</h2>
        <span className={AdminUI.cardDescription} id="admin-approvals-count">
          {payload ? (waiting.length ? `${waiting.length} waiting` : 'Nothing waiting') : 'Loading…'}
        </span>
      </div>
      <p className={`${AdminUI.muted} mb-3`} id="admin-approvals-about">
        A change that carries risk is held: it cannot go live until an admin other than its author votes yes on
        it. Open the change and vote there. Your yes lets it through once its votes and checks allow; your no,
        with a reason, closes it and the request it was built for. Without an answer it stays held.
      </p>
      <div className="flex items-center gap-2 mb-3" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'waiting'}
          className={tab === 'waiting' ? AdminUI.btn.primary : AdminUI.btn.outline}
          id="admin-approvals-tab-waiting"
          onClick={() => onTab('waiting')}
        >{`Waiting${waiting.length ? ` (${waiting.length})` : ''}`}</button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          className={tab === 'history' ? AdminUI.btn.primary : AdminUI.btn.outline}
          id="admin-approvals-tab-history"
          onClick={() => onTab('history')}
        >History</button>
      </div>
      {tab === 'waiting' ? (
        <div className={AdminUI.tableWrap}>
          <table className={`${AdminUI.table} min-w-[40rem]`} id="admin-approvals-waiting">
            <thead className={AdminUI.thead}>
              <tr>
                <th className={`${AdminUI.th} min-w-[14rem]`}>Change</th>
                <th className={`${AdminUI.th} min-w-[16rem]`}>Why it is held</th>
                <th className={AdminUI.th}>Waiting</th>
                <th className={AdminUI.th}>Your vote</th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((hold) => (
                <tr className={AdminUI.trHover} key={hold.id} data-release-hold-row={hold.id}>
                  <td className={AdminUI.td}><ChangeCell hold={hold} /></td>
                  <td className={AdminUI.td}><Reasons hold={hold} /></td>
                  <td className={`${AdminUI.td} whitespace-nowrap`}>{waited(hold.heldAt, now)}</td>
                  <td className={`${AdminUI.td} whitespace-nowrap`}>
                    {hold.needsAnotherAdmin
                      ? <span className={AdminUI.badge.secondary}>Needs another admin</span>
                      : <a className={AdminUI.btn.link} href={changeHref(hold.appSlug, hold.sessionId, hold.prNumber)}>Open to vote</a>}
                  </td>
                </tr>
              ))}
              {payload && waiting.length === 0 ? (
                <tr>
                  <td className={AdminUI.td} colSpan={4} id="admin-approvals-empty">
                    No change is waiting for an admin.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={AdminUI.tableWrap}>
          <table className={`${AdminUI.table} min-w-[40rem]`} id="admin-approvals-history">
            <thead className={AdminUI.thead}>
              <tr>
                <th className={AdminUI.th}>When</th>
                <th className={`${AdminUI.th} min-w-[14rem]`}>Change</th>
                <th className={`${AdminUI.th} min-w-[14rem]`}>Why it was held</th>
                <th className={`${AdminUI.th} min-w-[12rem]`}>What happened</th>
              </tr>
            </thead>
            <tbody>
              {history.map((hold) => (
                <tr className={AdminUI.trHover} key={hold.id} data-release-hold-row={hold.id} data-outcome={hold.outcome}>
                  <td className={`${AdminUI.td} whitespace-nowrap`}>{when(hold.decidedAt || hold.heldAt)}</td>
                  <td className={AdminUI.td}><ChangeCell hold={hold} /></td>
                  <td className={AdminUI.td}><Reasons hold={hold} /></td>
                  <td className={AdminUI.td}>
                    <span className={OUTCOME_BADGE[hold.outcome] || AdminUI.badge.secondary}>
                      {OUTCOME_LABEL[hold.outcome] || hold.outcome}
                    </span>
                    {hold.decidedBy ? <div className={`${AdminUI.muted} text-xs mt-1`}>{`by @${hold.decidedBy}`}</div> : null}
                    {hold.note ? <div className="text-xs mt-1">{hold.note}</div> : null}
                  </td>
                </tr>
              ))}
              {payload && history.length === 0 ? (
                <tr>
                  <td className={AdminUI.td} colSpan={4} id="admin-approvals-history-empty">
                    No change has been held yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      {payload?.rules?.length ? (
        <p className={`${AdminUI.muted} mt-3`} id="admin-approvals-rules">
          {`A change is held when: ${payload.rules.map((r) => r.words.charAt(0).toLowerCase() + r.words.slice(1)).join('; ')}.`}
        </p>
      ) : null}
    </div>
  );
}

function ApprovalsSection() {
  const console_ = () => (window as any).AdminConsole;
  const [payload, setPayload] = useState<ApprovalsPayload | null>(null);
  const [tab, setTab] = useState<'waiting' | 'history'>('waiting');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { data } = await console_().fetchJson('/api/admin/release-holds');
    if (alive.current && data && typeof data === 'object') setPayload(data as ApprovalsPayload);
  }, []);

  useEffect(() => { load(); }, [load]);

  return <ApprovalsView payload={payload} tab={tab} onTab={setTab} />;
}

let host: Element | null = null;

const AdminApprovals = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <ApprovalsSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminApprovals = AdminApprovals;

export { AdminApprovals };
