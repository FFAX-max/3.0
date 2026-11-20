import type { Assignee, Finding, WorkItem } from './api';
import { BUSY_STATUS } from './api';

export const ASSIGNEE_LABEL: Record<Assignee, string> = {
  claude: 'Claude（自动去改）',
  agent: '别的 AI（复制过去）',
  self: '我自己',
};

const STATUS_CLASS: Record<string, string> = {
  待分配: 'ws-idle',
  已分配: 'ws-assigned',
  处理中: 'ws-busy',
  复查中: 'ws-busy',
  已解决: 'ws-ok',
  复查没过: 'ws-bad',
  没改动: 'ws-bad',
  出错了: 'ws-bad',
  中断了: 'ws-bad',
  已关闭: 'ws-closed',
};

export function StatusChip({ status }: { status: string }) {
  return <span className={`wstatus ${STATUS_CLASS[status] || 'ws-idle'}`}>{status}</span>;
}

export const CAN_ASSIGN = new Set(['待分配', '复查没过', '没改动', '出错了', '中断了']);

const time = (iso: string) =>
  new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export function AssignButtons({ onAssign }: { onAssign: (to: Assignee) => void }) {
  return (
    <div className="assign">
      <span className="assign-label">交给：</span>
      <button type="button" onClick={() => onAssign('claude')} title="Claude 直接改仓库里的这个文件，改完自动复查">Claude 去改</button>
      <button type="button" onClick={() => onAssign('agent')} title="把这条问题复制到剪贴板，贴给别的 AI">复制给别的 AI</button>
      <button type="button" onClick={() => onAssign('self')} title="你自己改，改好了点“改好了，去复查”">我自己改</button>
    </div>
  );
}

export default function WorkPane({
  items,
  onAssign,
  onAct,
  onJump,
}: {
  items: WorkItem[];
  onAssign: (item: WorkItem, to: Assignee) => void;
  onAct: (id: string, action: 'done' | 'recheck' | 'close') => void;
  onJump: (f: Finding) => void;
}) {
  if (!items.length) {
    return <div className="hint pad">还没有工单。审查出问题后，在问题下面点“交给：…”，这里就会记下这条问题从发现到改好的每一步。</div>;
  }
  const sorted = [...items].sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)));
  const count = (s: string) => items.filter((i) => i.status === s).length;
  return (
    <div className="work">
      <div className="work-sum">
        共 {items.length} 条 · 已解决 {count('已解决')} · 进行中 {count('处理中') + count('复查中') + count('已分配')} · 待分配 {count('待分配')} · 没过 {count('复查没过') + count('没改动') + count('出错了') + count('中断了')}
      </div>
      {sorted.map((it) => {
        const busy = BUSY_STATUS.has(it.status);
        const f = it.finding;
        return (
          <div key={it.id} className="witem">
            <div className="witem-head">
              <span className="wid">{it.id}</span>
              <StatusChip status={it.status} />
              <span className="witem-title">{f.title}</span>
            </div>
            <button type="button" className="where link" onClick={() => onJump(f)}>
              {f.file}{f.line ? `:${f.line}` : ''}
            </button>
            <div className="wmeta">
              {f.severity} · {it.area}
              {it.assignee ? ` · 交给 ${ASSIGNEE_LABEL[it.assignee]}` : ''}
            </div>
            <ol className="chain">
              {it.events.map((e, i) => (
                <li key={i}>
                  <span className="ev-time">{time(e.at)}</span>
                  <span className="ev-who">{e.who}</span>
                  <span className="ev-what">{e.what}</span>
                  {e.detail && <div className="ev-detail">{e.detail}</div>}
                </li>
              ))}
              {busy && (
                <li className="ev-now">
                  <span className="ev-what">{it.status === '处理中' ? 'Claude 正在改……' : '正在复查……'}</span>
                </li>
              )}
            </ol>
            {!busy && (
              <div className="wactions">
                {CAN_ASSIGN.has(it.status) && <AssignButtons onAssign={(to) => onAssign(it, to)} />}
                {it.status === '已分配' && (
                  <button type="button" className="primary" onClick={() => onAct(it.id, 'done')}>改好了，去复查</button>
                )}
                {it.status !== '已分配' && it.status !== '待分配' && it.status !== '已关闭' && (
                  <button type="button" onClick={() => onAct(it.id, 'recheck')}>再复查一次</button>
                )}
                {it.status !== '已关闭' && (
                  <button type="button" onClick={() => onAct(it.id, 'close')}>关掉</button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
