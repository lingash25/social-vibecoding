'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Model costs (#admin/model-costs) — #2570.
//
// The model picker states what each model is good for and what a change on
// it is expected to cost. This screen is where that second number is kept
// honest: beside each estimate it shows what changes on that model ACTUALLY
// cost over the last 30 days, and an admin who sees the two drift apart
// types a new estimate in.
//
// The observed figure is deliberately NOT applied automatically — a median
// over a handful of changes moves violently, and a number in the picker
// that jumps because two people ran long sessions yesterday is worse than a
// stable one somebody chose. services/model-costs.js has the full reasoning.
//
// #2592: "what changes actually cost" now means the WHOLE change. The
// observed columns used to count chat turns only, because the coding
// agent's own spend (the large majority of a change) was recorded with no
// model against it, and a change that switched models was split in two.
// The paragraph under the heading says so, because a figure this screen
// exists to be trusted on has to state what it counted.
//
// PERMISSIONS: visible to any admin; the override field and its Save are
// gated on AdminConsole.canWrite(), and the server enforces the same with
// requireAdminWrite on PUT /api/admin/model-costs.

interface CostRow {
  modelId: string;
  note: string;
  derivedCents: number | null;
  overrideCents: number | null;
  shownCents: number | null;
  observedAvgCents: number | null;
  observedMedianCents: number | null;
  observedChanges: number;
}

interface CostPayload {
  days: number;
  typicalChange: {
    inputTokens: number;
    outputTokens: number;
    source: string;
    changes: number;
  };
  rows: CostRow[];
  // #2592: ISO instant the platform began recording coding-agent spend per
  // model. Null while no boot has stamped it, which is also the state in
  // which the observed columns are empty rather than understated.
  observedSince: string | null;
  observedError: string | null;
}

type Tone = 'ok' | 'err';
interface Status { text: string; tone: Tone }

/** Cents as dollars, to the cent, or an em-free placeholder when unknown. */
function money(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(Number(cents))) return '–';
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function tokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  // A typical change is measured in millions of input tokens now, and
  // "2500k" is a worse way to say 2.5M. One decimal, no trailing ".0".
  if (n >= 1_000_000) return `${String(Number((n / 1_000_000).toFixed(1)))}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** An ISO instant as a plain day, for the sentence that names the cutoff. */
function day(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function ModelCostsSection() {
  const console_ = () => (window as any).AdminConsole;
  const canWrite = !!console_()?.canWrite();

  const [payload, setPayload] = useState<CostPayload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const apply = useCallback((data: CostPayload) => {
    setPayload(data);
    // The field shows the override when there is one, and is blank when the
    // derived estimate is in force — blank is what clears it again.
    setDrafts(Object.fromEntries((data.rows || []).map((r) => [
      r.modelId,
      r.overrideCents == null ? '' : (Number(r.overrideCents) / 100).toFixed(2),
    ])));
  }, []);

  const load = useCallback(async () => {
    const { data } = await console_().fetchJson('/api/admin/model-costs');
    if (alive.current && data && typeof data === 'object') apply(data as CostPayload);
  }, [apply]);

  useEffect(() => { load(); }, [load]);

  const save = async (modelId: string) => {
    setStatus(null);
    setBusy(modelId);
    const raw = String(drafts[modelId] ?? '').trim();
    let cents: number | null = null;
    if (raw !== '') {
      const dollars = Number(raw);
      if (!Number.isFinite(dollars) || dollars < 0) {
        setStatus({ text: 'Enter a dollar amount, or leave it blank to use the derived estimate.', tone: 'err' });
        setBusy('');
        return;
      }
      cents = Math.round(dollars * 100);
    }
    try {
      const res = await fetch('/api/admin/model-costs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, cents }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!alive.current) return;
      apply(data as CostPayload);
      setStatus({
        text: cents == null
          ? `${modelId}: the derived estimate is back.`
          // #2570: never a bare amount in copy a person reads.
          : `${modelId}: the picker now says about ${money(cents)} for a typical change.`,
        tone: 'ok',
      });
    } catch (err: any) {
      if (alive.current) setStatus({ text: `Save failed: ${err.message}`, tone: 'err' });
    } finally {
      if (alive.current) setBusy('');
    }
  };

  const rows = payload?.rows || [];
  const profile = payload?.typicalChange;
  const cleanSince = day(payload?.observedSince);

  return (
    <div className={`${AdminUI.card} p-4`}>
      <div className={AdminUI.cardHeader}>
        <h2 className={AdminUI.cardTitle}>Model costs</h2>
        <span className={AdminUI.cardDescription}>
          {payload ? `Observed over the last ${payload.days} days` : 'Loading…'}
        </span>
      </div>
      <p className={`${AdminUI.muted} mb-4`} id="admin-model-costs-profile">
        {profile
          ? `Estimates are per-token pricing times a typical change: ${tokens(profile.inputTokens)} in, `
            + `${tokens(profile.outputTokens)} out (${profile.source === 'recorded_usage'
              ? `measured from ${profile.changes} recorded changes`
              : 'a documented constant, because there is not enough recorded usage yet'}). `
            + 'They assume a session running at the platform default reasoning effort; a session set to a '
            + 'different effort reads and writes a different number of tokens, so it costs more or less than this. '
            // #2592: say what a change IS. The observed figures used to read
            // low because the coding agent's own spend had no model recorded
            // against it and was left out, and because a session that
            // switched models was split into two partial changes.
            + 'The observed columns are what changes actually cost, the coding agent’s own spend included. '
            + 'One change is one dev session: all of its model calls counted once, and put against the '
            + 'model that spent the most in it. '
            + (cleanSince
              ? `Only changes started on or after ${cleanSince} are counted, because before then the `
                + 'agent’s spend had no model recorded against it. '
              : 'No change is counted yet: the platform records the agent’s spend per model from its next '
                + 'restart onward. ')
            + 'The observed columns never rewrite an estimate on their own. '
            + 'Type an override when the two have drifted apart, or clear it to go back to the derived figure.'
          : 'Reading the platform’s per-model spend…'}
      </p>
      {payload?.observedError ? (
        <p className="text-sm text-red-400 mb-3">
          The observed figures could not be read this time; the estimates below are still current.
        </p>
      ) : null}
      <div className={AdminUI.tableWrap}>
        <table className={AdminUI.table} id="admin-model-costs-table">
          <thead className={AdminUI.thead}>
            <tr>
              <th className={AdminUI.th}>Model</th>
              <th className={AdminUI.th}>Good for</th>
              {/* #2570: the cells hold bare amounts, so the headers carry
                  the unit. Every one of these is per TYPICAL CHANGE, which
                  the paragraph above defines. */}
              <th className={AdminUI.th}>Shown estimate, per typical change</th>
              <th className={AdminUI.th}>Observed average, per typical change</th>
              <th className={AdminUI.th}>Observed median, per typical change</th>
              <th className={AdminUI.th}>Changes</th>
              {canWrite ? <th className={AdminUI.th}>Override</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className={AdminUI.trHover} key={row.modelId} data-model-cost={row.modelId}>
                <td className={`${AdminUI.td} font-mono text-xs`}>{row.modelId}</td>
                <td className={AdminUI.td}>{row.note || '–'}</td>
                <td className={AdminUI.td}>
                  {money(row.shownCents)}
                  {row.overrideCents != null ? (
                    <span className={`${AdminUI.badge.secondary} ml-2`}>set by hand</span>
                  ) : null}
                </td>
                <td className={AdminUI.td}>{money(row.observedAvgCents)}</td>
                <td className={AdminUI.td}>{money(row.observedMedianCents)}</td>
                <td className={AdminUI.td}>{row.observedChanges}</td>
                {canWrite ? (
                  <td className={AdminUI.td}>
                    <div className="flex items-center gap-2">
                      <input
                        type="number" min="0" step="0.01" inputMode="decimal"
                        className={`${AdminUI.input} w-24`}
                        aria-label={`Estimate for ${row.modelId}, in dollars per typical change`}
                        placeholder={row.derivedCents == null ? 'none' : (Number(row.derivedCents) / 100).toFixed(2)}
                        value={drafts[row.modelId] ?? ''}
                        onChange={(e) => setDrafts((d) => ({ ...d, [row.modelId]: e.target.value }))}
                      />
                      <button
                        type="button" className={AdminUI.btn.primarySm}
                        disabled={busy === row.modelId}
                        onClick={() => save(row.modelId)}
                      >Save</button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className={AdminUI.td} colSpan={canWrite ? 7 : 6}>
                  No models to show yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p id="admin-model-costs-status" className={status
        ? `text-xs mt-3 ${status.tone === 'err' ? 'text-red-400' : 'text-green-800 dark:text-green-400'}`
        : 'text-xs mt-3 hidden'}>
        {status ? status.text : ''}
      </p>
    </div>
  );
}

let host: Element | null = null;

const AdminModelCosts = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <ModelCostsSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminModelCosts = AdminModelCosts;

export { AdminModelCosts };
