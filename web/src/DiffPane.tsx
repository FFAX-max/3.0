import { PatchDiff, type DiffLineAnnotation } from '@pierre/diffs/react';
import { useEffect, useMemo } from 'react';
import type { FileChange, Finding, Patch } from './api';

type Meta = { idx: number };

export const SEV_CLASS: Record<string, string> = { 高: 'sev-high', 中: 'sev-mid', 低: 'sev-low' };

export const findingKey = (f: Finding) => `${f.file}|${f.side}|${f.line}|${f.title}`;

function FindingNote({ f }: { f: Finding }) {
  return (
    <div className={`note ${SEV_CLASS[f.severity] || ''}`} data-fkey={findingKey(f)}>
      <div className="note-head">
        <span className="sev">{f.severity}</span>
        <span className="note-title">{f.title}</span>
      </div>
      {f.detail && <div className="note-text">{f.detail}</div>}
      {f.suggestion && <div className="note-text sugg">建议：{f.suggestion}</div>}
    </div>
  );
}

export default function DiffPane({
  file,
  patch,
  error,
  findings,
  focusKey,
}: {
  file: FileChange | null;
  patch: Patch | null;
  error: string;
  findings: Finding[];
  focusKey: string;
}) {
  // Scroll to the clicked finding once its annotation has rendered.
  useEffect(() => {
    if (!focusKey || !patch) return;
    const target = focusKey.split('#')[0]; // "#<time>" lets a repeated click scroll again
    let tries = 0;
    let timer = 0;
    const seek = () => {
      const el = [...document.querySelectorAll<HTMLElement>('[data-fkey]')].find((n) => n.dataset.fkey === target);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('flash');
        window.setTimeout(() => el.classList.remove('flash'), 1600);
      } else if (tries++ < 40) {
        timer = window.setTimeout(seek, 100);
      }
    };
    seek();
    return () => window.clearTimeout(timer);
  }, [focusKey, patch]);

  // Memoized so PatchDiff gets stable options and annotations.
  const options = useMemo(
    () => ({
      theme: { dark: 'pierre-dark', light: 'pierre-light' },
      themeType: 'dark' as const,
      diffStyle: 'split' as const,
      // Own file header above; plain hunk separators; wrap long lines.
      disableFileHeader: true,
      hunkSeparators: 'simple' as const,
      overflow: 'wrap' as const,
    }),
    [],
  );
  const annotations = useMemo<DiffLineAnnotation<Meta>[]>(
    () => findings.map((f, idx) => ({ side: f.side, lineNumber: f.line, metadata: { idx } })),
    [findings],
  );

  if (!file) return <div className="empty">左边选一个文件</div>;

  const renamed = file.oldPath && file.oldPath !== file.path;
  let body;
  if (error) body = <div className="empty">{error}</div>;
  else if (!patch) body = <div className="empty">正在读改动…</div>;
  else if (patch.tooLarge) body = <div className="empty">这个文件的改动太大（约 {Math.round((patch.size || 0) / 1024)} KB），不在这里逐行画</div>;
  else if (!/^@@/m.test(patch.patch)) body = <div className="empty">{renamed ? '只改了名字，内容没变' : '这个文件没有可以逐行对照的文字改动'}</div>;
  else
    body = (
      <PatchDiff<Meta>
        patch={patch.patch}
        options={options}
        lineAnnotations={annotations}
        renderAnnotation={(a) => <FindingNote f={findings[a.metadata.idx]} />}
      />
    );

  return (
    <div className="diff">
      <div className="diff-head">
        <span className={`st st-${file.status}`}>{file.status}</span>
        <span className="path">{renamed ? `${file.oldPath} → ${file.path}` : file.path}</span>
        {findings.length > 0 && <span className="mark">{findings.length} 条意见</span>}
        <span className="nums">
          <span className="plus">+{file.add ?? '–'}</span> <span className="minus">−{file.del ?? '–'}</span>
        </span>
      </div>
      <div className="diff-body">{body}</div>
    </div>
  );
}
