import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { Changes, FileChange } from './api';

type Node = { name: string; path: string; dirs: Map<string, Node>; files: FileChange[]; count: number };

const STATUS: Record<string, string> = { A: '新增', M: '修改', D: '删除', R: '改名', C: '复制', T: '类型变了' };

function build(files: FileChange[]): Node {
  const root: Node = { name: '', path: '', dirs: new Map(), files: [], count: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let n = root;
    n.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      let d = n.dirs.get(parts[i]);
      if (!d) {
        d = { name: parts[i], path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [], count: 0 };
        n.dirs.set(parts[i], d);
      }
      d.count++;
      n = d;
    }
    n.files.push(f);
  }
  return root;
}

function allDirs(n: Node, out: string[] = []): string[] {
  for (const d of n.dirs.values()) { out.push(d.path); allDirs(d, out); }
  return out;
}

const num = (v: number | null) => (v === null ? '–' : v.toLocaleString());

export default function FileTree({
  changes,
  selected,
  onSelect,
  marks,
}: {
  changes: Changes;
  selected: FileChange | null;
  onSelect: (f: FileChange) => void;
  marks: Map<string, number>;
}) {
  const root = useMemo(() => build(changes.files), [changes]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(changes.files.length <= 300 ? allDirs(root) : []));
  const [filter, setFilter] = useState('');

  // Expand the folders that contain the selected file
  useEffect(() => {
    if (!selected) return;
    const parts = selected.path.split('/');
    setOpen((s) => {
      const n = new Set(s);
      for (let i = 1; i < parts.length; i++) n.add(parts.slice(0, i).join('/'));
      return n;
    });
  }, [selected]);

  const toggle = (p: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p); else n.add(p);
      return n;
    });

  const fileRow = (f: FileChange, depth: number, showDir = false) => {
    const slash = f.path.lastIndexOf('/');
    const name = f.path.slice(slash + 1);
    const dir = slash > 0 ? f.path.slice(0, slash) : '';
    const mark = marks.get(f.path);
    return (
      <div
        key={`f:${f.path}`}
        className={`row${selected?.path === f.path ? ' sel' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => onSelect(f)}
        title={`${STATUS[f.status] || f.status}：${f.path}`}
      >
        <span className={`st st-${f.status}`}>{f.status}</span>
        <span className="name">{name}</span>
        {showDir && dir && <span className="dir-hint">{dir}</span>}
        {mark ? <span className="mark">{mark}</span> : null}
        <span className="nums">
          <span className="plus">+{num(f.add)}</span> <span className="minus">−{num(f.del)}</span>
        </span>
      </div>
    );
  };

  const renderNode = (n: Node, depth: number): ReactElement[] => {
    const out: ReactElement[] = [];
    const dirs = [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) {
      const isOpen = open.has(d.path);
      out.push(
        <div key={`d:${d.path}`} className="row dir" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => toggle(d.path)}>
          <span className="caret">{isOpen ? '▾' : '▸'}</span>
          <span className="name">{d.name}</span>
          <span className="count">{d.count}</span>
        </div>,
      );
      if (isOpen) out.push(...renderNode(d, depth + 1));
    }
    for (const f of [...n.files].sort((a, b) => a.path.localeCompare(b.path))) out.push(fileRow(f, depth));
    return out;
  };

  const q = filter.trim().toLowerCase();
  const matches = q ? changes.files.filter((f) => f.path.toLowerCase().includes(q)) : [];
  const t = changes.totals;

  return (
    <div className="tree">
      <div className="panel-title">
        {changes.mode === 'worktree' ? '还没提交的改动' : `${changes.base} ⇄ ${changes.head}`}
      </div>
      <div className="summary">
        {changes.mode === 'refs' && (
          <span>领先 <b>{changes.ahead}</b> · 落后 <b>{changes.behind}</b> · </span>
        )}
        <span><b>{t.files.toLocaleString()}</b> 个文件 </span>
        <span className="plus">+{t.add.toLocaleString()}</span> <span className="minus">−{t.del.toLocaleString()}</span>
      </div>
      <input className="filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="搜文件…" spellCheck={false} />
      <div className="rows">
        {t.files === 0 && <div className="empty">两边没有区别</div>}
        {q ? (
          <>
            <div className="hint pad">找到 {matches.length} 个{matches.length > 500 ? '，只列前 500 个' : ''}</div>
            {matches.slice(0, 500).map((f) => fileRow(f, 0, true))}
          </>
        ) : (
          renderNode(root, 0)
        )}
      </div>
    </div>
  );
}
