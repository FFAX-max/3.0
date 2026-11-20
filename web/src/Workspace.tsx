// Drag-and-drop panel layout (dockview). The layout is saved to localStorage on every change.
import 'dockview-react/dist/styles/dockview.css';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react';
import { createContext, useContext, type ReactNode } from 'react';

export type PanelId = 'files' | 'diff' | 'review' | 'work';

export const PANEL_TITLES: Record<PanelId, string> = { files: '改动的文件', diff: '左右对照', review: '审查', work: '工作链条' };
const LAYOUT_KEY = 'code-review-mirror:layout:v1';

// Panel contents come from App; each dockview panel renders its slot.
const Slots = createContext<Partial<Record<PanelId, ReactNode>>>({});

function Slot(props: IDockviewPanelProps) {
  const slots = useContext(Slots);
  return <div className="dv-slot">{slots[props.api.id as PanelId] ?? null}</div>;
}
const components = { slot: Slot };

export function defaultLayout(api: DockviewApi) {
  api.clear();
  api.addPanel({ id: 'diff', component: 'slot', title: PANEL_TITLES.diff });
  api.addPanel({ id: 'files', component: 'slot', title: PANEL_TITLES.files, position: { referencePanel: 'diff', direction: 'left' }, initialWidth: 320 });
  api.addPanel({ id: 'review', component: 'slot', title: PANEL_TITLES.review, position: { referencePanel: 'diff', direction: 'right' }, initialWidth: 400 });
  api.addPanel({ id: 'work', component: 'slot', title: PANEL_TITLES.work, position: { referencePanel: 'review', direction: 'within' } });
  api.getPanel('review')?.api.setActive();
}

// Bring back a closed panel near its default position
export function showPanel(api: DockviewApi, id: PanelId) {
  const p = api.getPanel(id);
  if (p) { p.api.setActive(); return; }
  const anchor = (['diff', 'review', 'files', 'work'] as PanelId[]).find((x) => x !== id && api.getPanel(x));
  const direction = id === 'files' ? 'left' : id === 'diff' ? 'within' : 'right';
  api.addPanel({ id, component: 'slot', title: PANEL_TITLES[id], ...(anchor ? { position: { referencePanel: anchor, direction } } : {}) });
}

export default function Workspace({
  slots,
  onApi,
}: {
  slots: Partial<Record<PanelId, ReactNode>>;
  onApi: (api: DockviewApi) => void;
}) {
  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    let restored = false;
    try {
      const saved = localStorage.getItem(LAYOUT_KEY);
      if (saved) {
        api.fromJSON(JSON.parse(saved));
        restored = api.panels.length > 0; // a saved layout may omit closed panels
      }
    } catch {
      restored = false;
    }
    if (!restored) defaultLayout(api);
    api.onDidLayoutChange(() => {
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON())); } catch { /* works without storage too */ }
    });
    onApi(api);
  };

  return (
    <Slots.Provider value={slots}>
      <DockviewReact className="dock dockview-theme-dark" onReady={onReady} components={components} />
    </Slots.Provider>
  );
}
