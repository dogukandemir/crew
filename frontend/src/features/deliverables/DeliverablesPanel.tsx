import { useMemo, useState } from 'react';
import type { DeliverableRow } from '../../api/types';
import { DownloadButton } from '../../components/ui/DownloadButton';
import { Chip } from '../../components/ui/Chip';
import { Input, Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Drawer';
import { EmptyState, SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { formatDateTime, formatRelativeTime } from '../../lib/format';
import {
  useArtifactContent,
  useCompanyArtifacts,
  useOrg,
  useProjectArtifacts,
  useProject,
} from '../../app/hooks';
import { useUi } from '../../stores/ui';
import { flattenOrg } from '../org/orgUtils';
import { latestFiles } from './versions';

/**
 * The deliverables surface, readable at every level of the org:
 * - project scope: everything this project produced, filterable by department
 *   or by one agent;
 * - company scope: everything the member projects produced, each row naming
 *   its agent and its project.
 * Click a row to read the file (bounded content read, sha + path shown).
 */

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export { formatSize as formatDeliverableSize };

function typeTag(name: string, mime: string): string {
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : '';
  if (ext && ext.length <= 4 && /^[a-z0-9]+$/i.test(ext)) return ext.toUpperCase();
  if (mime === 'application/json') return 'JSON';
  if (mime.startsWith('image/')) return 'IMG';
  if (mime.startsWith('text/')) return 'TXT';
  return 'FILE';
}

function fileDownloadUrl(artifactId: string): string {
  return `/api/artifacts/${artifactId}/download`;
}

function packDownloadUrl(
  scope: 'project' | 'company',
  id: string,
  params: Record<string, string | undefined>,
): string {
  const entries = Object.entries(params).filter(([, v]) => !!v) as [string, string][];
  const qs = new URLSearchParams(entries).toString();
  const base =
    scope === 'company'
      ? `/api/companies/${id}/artifacts/download`
      : `/api/projects/${id}/artifacts/download`;
  return `${base}${qs ? `?${qs}` : ''}`;
}

export function DeliverablesPanel({
  scope,
  id,
  tabId,
}: {
  scope: 'project' | 'company';
  id: string;
  tabId?: string;
}) {
  const isCompany = scope === 'company';
  const [dept, setDept] = useState('');
  const [agent, setAgent] = useState('');
  const [proj, setProj] = useState('');
  const [search, setSearch] = useState('');
  const [versions, setVersions] = useState('latest');
  const [runScope, setRunScope] = useState('current');
  const [preview, setPreview] = useState<DeliverableRow | null>(null);

  const org = useOrg(isCompany ? null : id);
  const project = useProject(isCompany ? null : id);
  const projectArt = useProjectArtifacts(isCompany ? null : id, {
    agent_id: agent || undefined,
    department_id: dept || undefined,
  });
  const companyArt = useCompanyArtifacts(isCompany ? id : null);
  const q = isCompany ? companyArt : projectArt;

  const { depts, agents } = useMemo(() => {
    const all = flattenOrg(org.data?.root);
    return {
      depts: all.filter((n) => n.kind === 'department'),
      agents: all.filter((n) => n.kind === 'agent'),
    };
  }, [org.data]);

  const rows = useMemo(() => {
    let out = q.data?.items ?? [];
    if (isCompany && proj) out = out.filter((r) => r.project_id === proj);
    if (!isCompany && runScope === 'current' && project.data?.latest_run_id) out = out.filter(row => row.run_id === project.data?.latest_run_id);
    if (versions === 'latest') out = latestFiles(out);
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      out = out.filter((r) =>
        `${r.name} ${r.agent_name ?? ''} ${r.task_title ?? ''} ${r.project_name ?? ''}`
          .toLowerCase()
          .includes(s),
      );
    }
    return out;
  }, [q.data, isCompany, proj, search, versions, runScope, project.data]);

  const projOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of companyArt.data?.items ?? []) m.set(r.project_id, r.project_name ?? r.project_id);
    return [...m.entries()];
  }, [companyArt.data]);

  if (!isCompany && org.isLoading) return <SkeletonRows rows={6} />;
  if (!isCompany && org.isError)
    return <PanelError error={org.error} onRetry={() => void org.refetch()} label="Org roster" />;
  if (q.isLoading) return <SkeletonRows rows={6} />;
  if (q.isError) return <PanelError error={q.error} onRetry={() => void q.refetch()} label="Deliverables" />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {!isCompany && project.data?.latest_run_id && <Select aria-label="Deliverable run" className="w-40"
          value={runScope} onChange={event => setRunScope(event.target.value)}>
          <option value="current">Latest run</option><option value="all">All runs</option>
        </Select>}
        <Select aria-label="File versions" className="w-40" value={versions} onChange={event => setVersions(event.target.value)}>
          <option value="latest">Latest files</option><option value="all">All versions</option>
        </Select>
        <Input
          aria-label="Search deliverables"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, agent, task…"
          className="w-56"
        />
        {!isCompany && (
          <>
            <Select aria-label="Filter by department" value={dept} onChange={(e) => setDept(e.target.value)} className="w-44">
              <option value="">All departments</option>
              {depts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
            <Select aria-label="Filter by agent" value={agent} onChange={(e) => setAgent(e.target.value)} className="w-48">
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </>
        )}
        {isCompany && (
          <Select aria-label="Filter by project" value={proj} onChange={(e) => setProj(e.target.value)} className="w-52">
            <option value="">All projects</option>
            {projOptions.map(([pid, name]) => (
              <option key={pid} value={pid}>
                {name}
              </option>
            ))}
          </Select>
        )}
        {rows.length > 0 && (
          <DownloadButton
            path={packDownloadUrl(scope, id, { artifact_ids: rows.map(row => row.id).join(',') })}
            filename={`${scope}-deliverables.zip`}
            className="rounded border border-slate-700/70 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800/60"
            title={
              isCompany
                ? 'Download visible files as one zip, filed per project'
                : 'Download visible files as one zip'
            }
          >
            ↓ Download visible files
          </DownloadButton>
        )}
        <span className="ml-auto text-[11px] tabular-nums text-slate-500">
          {rows.length} deliverable{rows.length === 1 ? '' : 's'}
        </span>
      </div>
      <p className="text-xs text-slate-400">{versions === 'latest'
        ? 'Showing the newest published copy of each file per agent in this view. Choose All versions for earlier copies, or All runs for previous work.'
        : 'Showing publication history, including older copies. Check task results before using a file.'}</p>

      {rows.length === 0 ? (
        <EmptyState
          title={(q.data?.items.length ?? 0) > 0 ? 'No matching files' : 'No deliverables yet'}
          description={
            (q.data?.items.length ?? 0) > 0 ? 'Try another search or clear the filters.' : isCompany
              ? 'Outputs published by the member projects land here, every row names its agent.'
              : agent || dept
                ? 'Nothing matches this filter yet.'
                : 'Run the project: agents publish their outputs here as real files you can read.'
          }
        />
      ) : (
        <ul className="divide-y divide-slate-800/60 rounded border border-slate-800/70">
          {rows.map((r) => (
            <DeliverableItem
              key={r.id}
              row={r}
              isCompany={isCompany}
              onOpen={() => setPreview(r)}
              onAgent={
                !isCompany && tabId && r.agent_id
                  ? () => useUi.getState().openDrawer(tabId, { kind: 'agent', id: r.agent_id as string, name: r.agent_name ?? undefined })
                  : undefined
              }
            />
          ))}
        </ul>
      )}

      <DeliverablePreviewModal row={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

function DeliverableItem({
  row,
  isCompany,
  onOpen,
  onAgent,
}: {
  row: DeliverableRow;
  isCompany: boolean;
  onOpen: () => void;
  onAgent?: () => void;
}) {
  return (
    <li>
      <div
        className="flex items-center gap-3 px-3 py-2 hover:bg-slate-900/60"
        title={row.task_title ? `From the task: ${row.task_title}` : row.path}
      >
        {/* One interactive element per row: the open button (nested buttons inside a
            role=button row break screen readers, review 2026-10-14). */}
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="w-9 shrink-0 rounded bg-slate-800/80 px-1 py-0.5 text-center text-[10px] font-semibold tracking-wide text-slate-400">
            {typeTag(row.name, row.mime)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-slate-200">{row.name}</span>
        </button>
        {isCompany && row.project_name && (
          <Chip tone="neutral" title="Project" className="hidden sm:inline-flex">
            {row.project_name}
          </Chip>
        )}
        {row.department_name && (
          <Chip tone="neutral" title="Department" className="hidden sm:inline-flex">
            {row.department_name}
          </Chip>
        )}
        <span className="hidden shrink-0 text-[11.5px] text-slate-400 md:inline">
          by{' '}
          {onAgent ? (
            <button
              type="button"
              className="font-medium text-slate-200 underline-offset-2 hover:underline"
              onClick={onAgent}
            >
              {row.agent_name ?? 'unknown'}
            </button>
          ) : (
            <span className="font-medium text-slate-200">{row.agent_name ?? 'unknown'}</span>
          )}
        </span>
        <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-slate-500">
          {formatSize(row.bytes)}
        </span>
        <span
          className="hidden w-20 shrink-0 text-right text-[11px] text-slate-500 sm:inline"
          title={formatDateTime(row.created_at)}
        >
          {formatRelativeTime(row.created_at)}
        </span>
        <DownloadButton
          path={fileDownloadUrl(row.id)}
          filename={row.name}
          className="shrink-0 rounded px-1 py-0.5 text-[12px] text-slate-500 hover:bg-slate-800/70 hover:text-slate-200"
          title="Download this file"
        >
          ↓
        </DownloadButton>
      </div>
    </li>
  );
}

/** Exported so other surfaces (the agent drawer) can preview the same record. */
export function DeliverablePreviewModal({ row, onClose }: { row: DeliverableRow | null; onClose: () => void }) {
  const content = useArtifactContent(row?.id);
  return (
    <Modal
      open={!!row}
      onClose={onClose}
      title={row?.name ?? ''}
      className="max-w-2xl"
      footer={
        row && (
          <div className="flex w-full min-w-0 items-center gap-x-3 text-[11px] text-slate-500">
            <DownloadButton
              path={fileDownloadUrl(row.id)}
              filename={row.name}
              title="Download this file"
              className="shrink-0 rounded border border-slate-700/70 px-2 py-0.5 text-slate-200 hover:bg-slate-800/60"
            >
              ↓ Download file
            </DownloadButton>
            <span className="shrink-0">sha256 {row.sha256.slice(0, 12)}…</span>
            <span className="min-w-0 flex-1 truncate" title={row.path}>
              {row.path}
            </span>
            <CopyPathButton path={row.path} />
          </div>
        )
      }
    >
      {row && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-400">
            <span>
              by <span className="font-medium text-slate-200">{row.agent_name ?? 'unknown'}</span>
            </span>
            {row.department_name && <Chip tone="neutral">{row.department_name}</Chip>}
            {row.project_name && (
              <Chip tone="neutral" title="Project">
                {row.project_name}
              </Chip>
            )}
            {row.task_title && (
              <span className="min-w-0 truncate" title={row.task_title}>
                task: <span className="text-slate-300">{row.task_title}</span>
              </span>
            )}
          </div>
          {content.isLoading ? (
            <SkeletonRows rows={6} />
          ) : content.isError ? (
            <div className="rounded border border-amber-900/40 bg-amber-950/20 p-3 text-[12px] text-amber-200/90">
              Could not read the file, the request failed.
            </div>
          ) : content.data?.available ? (
            <>
              {content.data.truncated && (
                <div className="rounded border border-slate-800/70 bg-slate-900/40 p-2 text-[11px] text-slate-400">
                  Showing the first 256 KB of this file.
                </div>
              )}
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-slate-800/70 bg-slate-950/60 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                {content.data.text}
              </pre>
            </>
          ) : (
            <div className="rounded border border-amber-900/40 bg-amber-950/20 p-3 text-[12px] text-amber-200/90">
              File not available, {content.data?.reason ?? 'unknown reason'}.
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** Copies the full path; the button turns into a check for a moment. */
function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy path"
      title={copied ? 'Copied' : 'Copy path'}
      className="shrink-0 rounded border border-slate-700/70 p-1 text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
      onClick={(e) => {
        e.stopPropagation();
        const done = () => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        };
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(path).then(done).catch(() => {
            // older/insecure contexts: the textarea fallback still copies
            const ta = document.createElement('textarea');
            ta.value = path;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            done();
          });
        }
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
