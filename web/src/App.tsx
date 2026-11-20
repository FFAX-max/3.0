import type { DockviewApi } from 'dockview-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  BUSY_STATUS,
  type Assignee,
  type Changes,
  type FileChange,
  type Finding,
  type Mode,
  type ModelStatus,
  type Patch,
  type RepoInfo,
  type ReviewRun,
  type WorkItem,
} from './api';
import DiffPane, { findingKey } from './DiffPane';
import FileTree from './FileTree';
import ReviewPane, { promptFor } from './ReviewPane';
import WorkPane from './WorkPane';
import Workspace, { defaultLayout, PANEL_TITLES, showPanel, type PanelId } from './Workspace';

const LAST = 'code-review-mirror:last';
type Last = { repo: string; mode: Mode; base: string; head: string };

function loadLast(): Partial<Last> {
  try { return JSON.parse(localStorage.getItem(LAST) || '{}'); } catch { return {}; }
}
function saveLast(v: Last) {
  try { localStorage.setItem(LAST, JSON.stringify(v)); } catch { /* works without storage too */ }
}

export default function App() {
  const [repoInput, setRepoInput] = useState('');
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [mode, setMode] = useState<Mode>('refs');
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [changes, setChanges] = useState<Changes | null>(null);
  const [selected, setSelected] = useState<FileChange | null>(null);
  const [patch, setPatch] = useState<Patch | null>(null);
  const [patchError, setPatchError] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [run, setRun] = useState<ReviewRun | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [focusKey, setFocusKey] = useState('');
  const [work, setWork] = useState<WorkItem[]>([]);
  const [workError, setWorkError] = useState('');

  const loadWork = useCallback(async (root: string) => {
    try {
      const r = await api.work(root);
      setWork(r.items);
    } catch (e) {
      setWorkError((e as Error).message);
    }
  }, []);

  const refreshModel = useCallback(() => {
    api.model().then(setModel).catch(() => setModel(null));
  }, []);

  const compare = useCallback(async (root: string, m: Mode, b: string, h: string) => {
    setBusy('正在比较…');
    setError('');
    setSelected(null);
    setPatch(null);
    setRun(null);
    setReviewError('');
    try {
      const c = await api.changes(root, m, b, h);
      setChanges(c);
      saveLast({ repo: root, mode: m, base: b, head: h });
      loadWork(root);
      // Restore the latest saved review of this comparison.
      api.runs(root)
        .then((list) => {
          const hit = list.find((r) => r.mode === m && (m === 'worktree' || (r.base === b && r.head === h)));
          return hit ? api.run(hit.id) : null;
        })
        .then((r) => { if (r) setRun(r); })
        .catch(() => { /* none saved */ });
      // Prefer a file with text changes.
      setSelected(
        c.files.find((f) => !f.binary && (f.add || 0) + (f.del || 0) > 0) ||
          c.files.find((f) => !f.binary) ||
          c.files[0] ||
          null,
      );
    } catch (e) {
      setChanges(null);
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }, [loadWork]);

  const openRepo = useCallback(async (p: string, prefer?: Partial<Last>) => {
    setBusy('正在打开仓库…');
    setError('');
    try {
      const info = await api.repo(p.trim());
      setRepo(info);
      setRepoInput(info.root);
      const pick = (want: string | undefined, fallbacks: string[]) =>
        [want, ...fallbacks].find((r) => r && info.branches.includes(r)) || '';
      const b = pick(prefer?.base, ['origin/main', 'main', 'origin/master', 'master']);
      const h = pick(prefer?.head, [info.current]);
      const m: Mode = prefer?.mode === 'worktree' ? 'worktree' : 'refs';
      setBase(b);
      setHead(h);
      setMode(m);
      if (m === 'worktree' || (b && h)) await compare(info.root, m, b, h);
      else setBusy('');
    } catch (e) {
      setRepo(null);
      setChanges(null);
      setError((e as Error).message);
      setBusy('');
    }
  }, [compare]);

  useEffect(() => {
    refreshModel();
    const last = loadLast();
    api.config()
      .then((cfg) => {
        const start = last.repo || cfg.defaultRepo;
        if (start) {
          setRepoInput(start);
          openRepo(start, last.repo === start ? last : undefined);
        }
      })
      .catch((e) => setError((e as Error).message));
  }, [openRepo, refreshModel]);

  useEffect(() => {
    setPatch(null);
    setPatchError('');
    if (!repo || !changes || !selected) return;
    if (selected.binary) { setPatchError('这是二进制文件，没法逐行对照'); return; }
    let alive = true;
    api.patch(repo.root, changes.mode, changes.base, changes.head, selected)
      .then((p) => { if (alive) setPatch(p); })
      .catch((e) => { if (alive) setPatchError((e as Error).message); });
    return () => { alive = false; };
  }, [repo, changes, selected]);

  // Poll while a fix or recheck is running.
  const anyBusy = work.some((w) => BUSY_STATUS.has(w.status));
  useEffect(() => {
    if (!anyBusy || !repo) return;
    const t = window.setInterval(() => loadWork(repo.root), 3000);
    return () => window.clearInterval(t);
  }, [anyBusy, repo, loadWork]);

  const dock = useRef<DockviewApi | null>(null);
  const reveal = (id: PanelId) => { if (dock.current) showPanel(dock.current, id); };

  const assignItem = async (item: WorkItem, to: Assignee) => {
    if (!repo) return;
    setWorkError('');
    try {
      if (to === 'agent') {
        await navigator.clipboard.writeText(promptFor(repo.root, item.run, [item.finding])).catch(() => {});
      }
      await api.workAction(repo.root, item.id, 'assign', { to });
    } catch (e) {
      setWorkError((e as Error).message);
    }
    await loadWork(repo.root);
  };

  const assignFinding = async (f: Finding, to: Assignee) => {
    if (!repo || !run) return;
    setWorkError('');
    try {
      const key = findingKey(f);
      let item = work.find((w) => w.key === key);
      if (!item) {
        const r = await api.workFromRun(repo.root, run.id, [key]);
        setWork(r.items);
        item = r.items.find((w) => w.key === key);
      }
      if (!item) throw new Error('没能把这条问题记成工单');
      await api.workAction(repo.root, item.id, 'assign', { to });
    } catch (e) {
      setWorkError((e as Error).message);
    }
    await loadWork(repo.root);
  };

  const act = async (id: string, action: 'done' | 'recheck' | 'close') => {
    if (!repo) return;
    setWorkError('');
    try {
      await api.workAction(repo.root, id, action);
    } catch (e) {
      setWorkError((e as Error).message);
    }
    await loadWork(repo.root);
  };

  const startReview = async (scope: 'file' | 'all') => {
    if (!repo || !changes) return;
    setReviewing(true);
    setReviewError('');
    try {
      const r = await api.review({
        path: repo.root,
        mode: changes.mode,
        base: changes.base,
        head: changes.head,
        files: scope === 'file' && selected ? [selected.path] : undefined,
      });
      setRun(r);
    } catch (e) {
      setReviewError((e as Error).message);
    } finally {
      setReviewing(false);
      refreshModel();
    }
  };

  const allFindings = useMemo(() => (run ? run.focusAreas.flatMap((a) => a.findings) : []), [run]);
  const fileFindings = useMemo(
    () => (selected ? allFindings.filter((f) => f.file === selected.path) : []),
    [allFindings, selected],
  );
  const marks = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of allFindings) m.set(f.file, (m.get(f.file) || 0) + 1);
    return m;
  }, [allFindings]);

  const jump = (f: Finding) => {
    const target = changes?.files.find((x) => x.path === f.file);
    if (!target) return;
    setFocusKey(`${findingKey(f)}#${Date.now()}`);
    if (target.path !== selected?.path) setSelected(target);
    reveal('diff');
  };

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">代码镜子</div>
        <form
          className="repo"
          onSubmit={(e) => { e.preventDefault(); if (repoInput.trim()) openRepo(repoInput); }}
        >
          <input
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="仓库文件夹的完整路径，例如 /Users/me/projects/my-app"
            spellCheck={false}
          />
          <button type="submit">打开</button>
        </form>
        {repo && (
          <div className="compare">
            <div className="seg">
              <button type="button" className={mode === 'refs' ? 'on' : ''} onClick={() => setMode('refs')}>两个分支比较</button>
              <button type="button" className={mode === 'worktree' ? 'on' : ''} onClick={() => setMode('worktree')}>还没提交的改动</button>
            </div>
            {mode === 'refs' && (
              <>
                <select value={base} onChange={(e) => setBase(e.target.value)} title="拿什么当底">
                  <option value="" disabled>选一边</option>
                  {repo.branches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
                <button type="button" className="swap" title="两边对调" onClick={() => { setBase(head); setHead(base); }}>⇄</button>
                <select value={head} onChange={(e) => setHead(e.target.value)} title="看哪一边的改动">
                  <option value="" disabled>选一边</option>
                  {repo.branches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </>
            )}
            <button
              type="button"
              className="primary"
              disabled={!!busy || (mode === 'refs' && (!base || !head))}
              onClick={() => compare(repo.root, mode, base, head)}
            >
              比较
            </button>
          </div>
        )}
        <div className="status">{busy ? busy : error ? <span className="err">{error}</span> : null}</div>
        <div className="panels">
          <span className="hint">面板：</span>
          {(['files', 'diff', 'review', 'work'] as PanelId[]).map((id) => (
            <button key={id} type="button" className="link" onClick={() => reveal(id)}>
              {PANEL_TITLES[id]}
            </button>
          ))}
          <button type="button" onClick={() => { if (dock.current) defaultLayout(dock.current); }} title="四个面板放回原来的位置">
            恢复默认布局
          </button>
        </div>
      </header>

      <main className="body">
        <Workspace
          onApi={(a) => { dock.current = a; }}
          slots={{
            files: changes ? (
              <FileTree
                key={`${changes.mode}|${changes.base}|${changes.head}|${changes.totals.files}`}
                changes={changes}
                selected={selected}
                onSelect={(f) => { setSelected(f); reveal('diff'); }}
                marks={marks}
              />
            ) : (
              <div className="empty">打开一个仓库，选好要比较的两边</div>
            ),
            diff: (
              <DiffPane
                file={selected}
                patch={patch}
                error={patchError}
                findings={fileFindings}
                focusKey={focusKey}
                key={selected?.path || ''}
              />
            ),
            review: (
              <ReviewPane
                model={model}
                onRefreshModel={refreshModel}
                canReview={!!changes && changes.files.length > 0}
                selected={selected}
                run={run}
                reviewing={reviewing}
                error={reviewError}
                onReview={startReview}
                onJump={jump}
                work={work}
                workError={workError}
                onAssignFinding={assignFinding}
                onShowWork={() => reveal('work')}
              />
            ),
            work: <WorkPane items={work} canFix={model?.engine === 'claude'} onAssign={assignItem} onAct={act} onJump={jump} />,
          }}
        />
      </main>
    </div>
  );
}
