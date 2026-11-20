export type Mode = 'refs' | 'worktree';

export type FileChange = {
  path: string;
  oldPath?: string;
  status: string;
  add: number | null;
  del: number | null;
  binary: boolean;
  untracked?: boolean;
};

export type Changes = {
  root: string;
  mode: Mode;
  base: string;
  head: string;
  ahead?: number;
  behind?: number;
  files: FileChange[];
  totals: { files: number; add: number; del: number };
};

export type RepoInfo = { root: string; current: string; branches: string[] };

export type ModelStatus = {
  engine?: 'claude' | 'openai';
  version?: string;
  url: string;
  model: string;
  reachable: boolean;
  hasModel?: boolean;
  models?: string[];
  error?: string;
};

export type Finding = {
  file: string;
  line: number;
  side: 'additions' | 'deletions';
  severity: string;
  title: string;
  detail: string;
  suggestion: string;
  inChange: boolean;
};

export type FocusArea = { title: string; why: string; findings: Finding[] };

export type ReviewRun = {
  id: string;
  at: string;
  root: string;
  mode: Mode;
  base: string;
  head: string;
  model: string;
  seconds: number;
  included: string[];
  skipped: { path: string; why: string }[];
  summary: string;
  focusAreas: FocusArea[];
  parsed: boolean;
  raw?: string;
};

export type Patch = { patch: string; tooLarge?: boolean; size?: number };

export type Assignee = 'claude' | 'agent' | 'self';

export type WorkEvent = { at: string; who: string; what: string; detail?: string };

export type WorkItem = {
  id: string;
  key: string;
  area: string;
  finding: Finding;
  run: { id: string; at: string; mode: Mode; base: string; head: string; model: string };
  status: string;
  assignee: Assignee | null;
  fixSession?: string | null;
  events: WorkEvent[];
};

export const BUSY_STATUS = new Set(['处理中', '复查中']);

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  let body: unknown = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) {
    const msg = (body as { error?: string } | null)?.error;
    throw new Error(msg || `HTTP ${r.status}`);
  }
  return body as T;
}

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const api = {
  config: () => call<{ defaultRepo: string; engine: string; model: string; budget: number }>('/api/config'),
  model: () => call<ModelStatus>('/api/model'),
  repo: (path: string) => call<RepoInfo>(`/api/repo?${qs({ path })}`),
  changes: (path: string, mode: Mode, base: string, head: string) =>
    call<Changes>(`/api/changes?${qs({ path, mode, base, head })}`),
  patch: (path: string, mode: Mode, base: string, head: string, f: FileChange) =>
    call<Patch>(`/api/patch?${qs({ path, mode, base, head, file: f.path, old: f.oldPath || '', untracked: f.untracked ? '1' : '' })}`),
  runs: (path: string) =>
    call<{ id: string; at: string; mode: Mode; base: string; head: string; files: number; findings: number }[]>(`/api/runs?${qs({ path })}`),
  run: (id: string) => call<ReviewRun>(`/api/runs/${encodeURIComponent(id)}`),
  work: (path: string) => call<{ items: WorkItem[] }>(`/api/work?${qs({ path })}`),
  workFromRun: (path: string, runId: string, keys?: string[]) =>
    call<{ ids: string[]; items: WorkItem[] }>('/api/work/from-run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, runId, keys }),
    }),
  workAction: (path: string, id: string, action: 'assign' | 'done' | 'recheck' | 'close', extra?: Record<string, string>) =>
    call<WorkItem>(`/api/work/${encodeURIComponent(id)}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, ...extra }),
    }),
  review: (body: { path: string; mode: Mode; base: string; head: string; files?: string[] }) =>
    call<ReviewRun>('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
};
