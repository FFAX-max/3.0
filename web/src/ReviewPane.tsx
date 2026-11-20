import { useState } from 'react';
import type { Assignee, FileChange, Finding, Mode, ModelStatus, ReviewRun, WorkItem } from './api';
import { findingKey, SEV_CLASS } from './DiffPane';
import { ASSIGNEE_LABEL, AssignButtons, CAN_ASSIGN, StatusChip } from './WorkPane';

export function promptFor(root: string, scope: { mode: Mode; base: string; head: string }, items: Finding[]): string {
  const where = scope.mode === 'worktree' ? '还没提交的改动' : `${scope.base}...${scope.head}`;
  const lines = [`请按下面的代码审查意见修改（仓库：${root}，改动范围：${where}）：`, ''];
  items.forEach((f, i) => {
    lines.push(`${i + 1}. [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} ${f.title}`);
    if (f.detail) lines.push(`   原因：${f.detail}`);
    if (f.suggestion) lines.push(`   建议：${f.suggestion}`);
  });
  return lines.join('\n');
}

export default function ReviewPane({
  model,
  onRefreshModel,
  canReview,
  selected,
  run,
  reviewing,
  error,
  onReview,
  onJump,
  work,
  workError,
  onAssignFinding,
  onShowWork,
}: {
  model: ModelStatus | null;
  onRefreshModel: () => void;
  canReview: boolean;
  selected: FileChange | null;
  run: ReviewRun | null;
  reviewing: boolean;
  error: string;
  onReview: (scope: 'file' | 'all') => void;
  onJump: (f: Finding) => void;
  work: WorkItem[];
  workError: string;
  onAssignFinding: (f: Finding, to: Assignee) => void;
  onShowWork: () => void;
}) {
  const [copied, setCopied] = useState('');
  const [showSkipped, setShowSkipped] = useState(false);

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      setCopied('fail');
    }
    setTimeout(() => setCopied(''), 1800);
  };
  const copyLabel = (key: string) => (copied === key ? '已复制' : copied === 'fail' ? '复制失败' : '复制给代理');

  const ready = !!model?.reachable && !!model?.hasModel;
  const all = run ? run.focusAreas.flatMap((a) => a.findings) : [];
  const byKey = new Map(work.map((w) => [w.key, w]));

  // "Copy to another AI": copy first, then record it in the chain
  const assignFinding = (f: Finding, to: Assignee) => {
    if (to === 'agent' && run) copy(`agent-${findingKey(f)}`, promptFor(run.root, run, [f]));
    onAssignFinding(f, to);
  };

  return (
    <div className="review">
      {workError && <div className="err-box">{workError}</div>}
      <div className="model">
        <span className={`dot ${ready ? 'ok' : 'bad'}`} />
        <span>审查用：{model ? model.model : '…'}</span>
        <button type="button" className="link" onClick={onRefreshModel}>刷新</button>
        {model?.engine === 'claude' && model.reachable && (
          <div className="hint">这台电脑上的 Claude Code 命令行 {model.version}，模型在云端跑，不往电脑里下模型</div>
        )}
        {model && !model.reachable && <div className="hint">{model.error}（{model.url}）</div>}
        {model && model.reachable && !model.hasModel && (
          <div className="hint">模型服务开着，但里面没有 {model.model}。现有：{(model.models || []).join('、') || '一个也没有'}</div>
        )}
      </div>

      <div className="actions">
        <button type="button" className="primary" disabled={!canReview || reviewing} onClick={() => onReview('all')}>
          审查差异
        </button>
        <button type="button" disabled={!selected || reviewing} onClick={() => onReview('file')}>
          只审这个文件
        </button>
      </div>

      {reviewing && <div className="hint">正在读改动，可能要一两分钟，别关这个页面。</div>}
      {error && <div className="err-box">{error}</div>}

      {run && (
        <div className="result">
          <div className="meta">
            {new Date(run.at).toLocaleString('zh-CN', { hour12: false })} 审的 · {run.model} · 用了 {run.seconds} 秒 · 审了 {run.included.length} 个文件
            {run.skipped.length > 0 && (
              <>
                {' · '}
                <button type="button" className="link" onClick={() => setShowSkipped((v) => !v)}>
                  没审 {run.skipped.length} 个
                </button>
              </>
            )}
          </div>
          {showSkipped && (
            <div className="skipped">
              {run.skipped.slice(0, 300).map((s) => (
                <div key={s.path}><span className="why">{s.why}</span> {s.path}</div>
              ))}
              {run.skipped.length > 300 && <div className="hint">……只列前 300 个</div>}
            </div>
          )}

          {!run.parsed && (
            <div className="err-box">
              模型的回答不是规定的格式，下面是它的原话：
              <pre className="raw">{run.raw}</pre>
            </div>
          )}

          {run.summary && <div className="summary-text">{run.summary}</div>}

          {run.parsed && all.length === 0 && <div className="hint">这次没找出问题。</div>}

          {all.length > 0 && (
            <button type="button" className="copy-all" onClick={() => copy('all', promptFor(run.root, run, all))}>
              {copied === 'all' ? '已复制' : `全部 ${all.length} 条复制给代理`}
            </button>
          )}

          {run.focusAreas.map((a, ai) => (
            <div key={ai} className="area">
              <div className="area-head">
                <span className="area-title">{a.title}</span>
                <span className="count">{a.findings.length}</span>
                {a.findings.length > 0 && (
                  <button type="button" className="link" onClick={() => copy(`a${ai}`, promptFor(run.root, run, a.findings))}>
                    {copyLabel(`a${ai}`)}
                  </button>
                )}
              </div>
              {a.why && <div className="area-why">{a.why}</div>}
              {a.findings.map((f, fi) => {
                const item = byKey.get(findingKey(f));
                return (
                  <div key={fi} className={`finding ${SEV_CLASS[f.severity] || ''}`}>
                    <div className="finding-head">
                      <span className="sev">{f.severity}</span>
                      <span className="finding-title">{f.title}</span>
                    </div>
                    <button
                      type="button"
                      className="where link"
                      disabled={!f.inChange}
                      title={f.inChange ? '跳到这一行' : '模型写的文件不在这次审查的改动里'}
                      onClick={() => onJump(f)}
                    >
                      {f.file || '（没写文件）'}{f.line ? `:${f.line}` : ''}{!f.inChange && '（不在这次改动里）'}
                    </button>
                    {f.detail && <div className="finding-text">{f.detail}</div>}
                    {f.suggestion && <div className="finding-text sugg">建议：{f.suggestion}</div>}
                    {item && (
                      <div className="tracked">
                        <span className="wid">{item.id}</span>
                        <StatusChip status={item.status} />
                        {item.assignee && <span className="hint">交给 {ASSIGNEE_LABEL[item.assignee]}</span>}
                        <button type="button" className="link" onClick={onShowWork}>看链条</button>
                      </div>
                    )}
                    {(!item || CAN_ASSIGN.has(item.status)) && f.inChange && (
                      <AssignButtons onAssign={(to) => assignFinding(f, to)} />
                    )}
                    {copied === `agent-${findingKey(f)}` && <div className="hint">已复制，贴给别的 AI 就行</div>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
