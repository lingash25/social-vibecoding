/**
 * `#agent-files-instructions-list` / `#agent-files-skills-list` — the agent
 * instructions and skills rows, as the only React writer below either host.
 *
 * Both hosts are STATIC in the React tree (sections/agent-files.tsx), so these
 * are plain children rather than portals. settings.js keeps every fetch, the
 * upload form, the confirm dialog and the status line; this file keeps the
 * markup.
 *
 * ── The View toggle is component state, and that fixes a bug ──────────
 *
 * The DOM version stashed a file's fetched content in the `<pre>`'s
 * textContent and used `classList.contains('hidden')` as the open flag. Both
 * lived on a node the next `_loadAgentFiles()` destroyed — so opening a file,
 * deleting a different one, and opening the first again re-fetched content
 * that had already been fetched. `useState` here is scoped to the row and
 * survives a sibling's delete, because React keeps the row element when its
 * key is unchanged.
 *
 * `Delete` still goes back to settings.js by name: it owns the confirm dialog,
 * the API call, the status line and the reload.
 *
 * Every row has a View and a Delete, so both buttons name their file in
 * `aria-label`: a screen reader otherwise hears a list of identical
 * "View, Delete" pairs and cannot tell which file a Delete removes. View also
 * reports `aria-expanded` and points `aria-controls` at its `<pre>`.
 */

import { useState } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { agentFilesStore } from './agent-files-store.js';

type AgentFileView = { kind: string; name: string; description: string; kb: number };

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

/*
 * A floating white card. The string this replaces was
 * `bg-zinc-100 … border border-zinc-300`, and zinc-100 IS the settings page
 * ground (#eaeaea) in this palette — the fill did nothing and the border was
 * the only thing drawing the row. Same correction as the grants rows.
 */
const ROW_CLASS = 'rounded-lg bg-white dark:bg-zinc-900 px-3 py-2 text-xs';

/**
 * The `<pre>`'s id, unique per file: kind and name with every character an id
 * should not carry (and `_`, the escape itself) written as `_<hex>_`, so two
 * different names can never map to the same id.
 */
export function agentFileContentId(kind: string, name: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.codePointAt(0)!.toString(16)}_`);
  return `agent-file-content-${safe(kind)}-${safe(name)}`;
}

function FileRow({ file, demo }: { file: AgentFileView; demo: boolean }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  // A failed load is DISPLAYED like a successful one — the message goes in the
  // pane, where the DOM version put it — but it is not CACHED like one. The
  // old `if (!pre.textContent)` guard could not tell the two apart, so a
  // network blip left "Failed to load: …" pinned in the pane for the life of
  // the row, with every re-open a no-op. Here the next open retries.
  const [failed, setFailed] = useState(false);
  const contentId = agentFileContentId(file.kind, file.name);

  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (content !== null && !failed) return;
    setContent('Loading…');
    setFailed(false);
    try {
      const qs = `kind=${encodeURIComponent(file.kind)}&name=${encodeURIComponent(file.name)}`
        + (demo ? '&demo=1' : '');
      const r = await fetch(`/api/me/agent-files/content?${qs}`, { credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'fetch failed');
      setContent(j.file?.content || '(empty)');
    } catch (err) {
      setContent('Failed to load: ' + (err as Error).message);
      setFailed(true);
    }
  };

  return (
    <div className={ROW_CLASS} data-agent-file={file.kind}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300 truncate">{file.name}</span>
        <span className="shrink-0 flex items-center gap-2">
          <span className="text-zinc-500 dark:text-zinc-500">{`${file.kb} KB`}</span>
          <button
            type="button"
            data-role="view"
            className="text-violet-700 hover:text-violet-800 dark:text-violet-400 dark:hover:text-violet-300 font-medium touch-target-32"
            aria-expanded={open}
            aria-controls={contentId}
            aria-label={`${open ? 'Hide' : 'View'} ${file.name}`}
            onClick={() => { void toggle(); }}
          >
            {open ? 'Hide' : 'View'}
          </button>
          <button
            type="button"
            data-role="delete"
            className="text-red-700 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 font-medium touch-target-32"
            aria-label={`Delete ${file.name}`}
            onClick={() => { void controller()?._onAgentFileDelete?.(file.kind, file.name); }}
          >
            Delete
          </button>
        </span>
      </div>
      {file.description ? (
        <div className="text-zinc-500 dark:text-zinc-500 mt-1 truncate">{file.description}</div>
      ) : null}
      {open ? (
        <pre
          id={contentId}
          data-role="content"
          className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-zinc-50 dark:bg-zinc-950 px-2 py-1.5 font-mono text-[11px] text-zinc-700 dark:text-zinc-300"
        >
          {content ?? ''}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * `kind` names which list this host shows. One component for both: they are
 * the same rows from the same fetch, and the difference (which files, and what
 * the empty line says) is data.
 */
export function AgentFilesList({ kind, empty }: { kind: string; empty: string }) {
  const state = useStoreState(agentFilesStore);
  if (state.phase === 'idle') return null;
  // The loading and error lines belong to the INSTRUCTIONS host only, exactly
  // as they did before: one fetch feeds both lists, and saying "Loading…"
  // twice for one request reads as two requests.
  if (state.phase === 'loading') {
    return kind === 'instruction' ? <p className="text-xs text-zinc-500 dark:text-zinc-400">Loading…</p> : null;
  }
  if (state.phase === 'error') {
    return kind === 'instruction'
      ? <p className="text-xs text-red-700 dark:text-red-400">Failed to load your agent files.</p>
      : null;
  }
  const files = state.files.filter((f) => f.kind === kind);
  if (!files.length) return <p className="text-xs text-zinc-500 dark:text-zinc-500">{empty}</p>;
  return (
    <>
      {files.map((f) => <FileRow key={`${f.kind}:${f.name}`} file={f} demo={state.demo} />)}
    </>
  );
}
