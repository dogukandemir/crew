/**
 * The office tab, and the renderer it runs.
 *
 * WebGL is the main event, but it is not guaranteed: a machine without a GPU,
 * a headless browser, or a driver that refuses a context would otherwise show a
 * blank rectangle. So the tab probes for a context up front and falls back to the
 * 2D floor plan, which needs no GPU and shows the same simulation. The choice is
 * remembered, and can be switched either way from the HUD.
 */
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { EmptyState } from '../../components/ui/EmptyState';
import { OfficeFloor } from '../office/OfficeFloor';

// The 3D renderer pulls in three.js, so it is loaded on demand and kept in its
// own chunk — the data panels should not pay for it.
const Office3D = lazy(() => import('./Office3D').then((m) => ({ default: m.Office3D })));

const STORAGE_KEY = 'crew.office.renderer';

type Renderer = '3d' | '2d';

/**
 * The 2.5D floor is the default: it is the cute, legible view that sells the
 * product, it draws the same cast as SVG, and it needs no GPU, so it works on
 * every machine. The WebGL office is one click away for people who want to walk
 * around the building.
 */
const DEFAULT_RENDERER: Renderer = '2d';

/** Probe for a usable WebGL context, and hand it straight back. */
function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return false;
    // Some drivers hand out a context that is already lost; make sure it lives.
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function stored(): Renderer | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === '3d' || value === '2d' ? value : null;
  } catch {
    return null;
  }
}

export function OfficeTab({ projectId, tabId }: { projectId: string; tabId: string }) {
  const [renderer, setRenderer] = useState<Renderer | null>(null);

  useEffect(() => {
    const choice = stored() ?? DEFAULT_RENDERER;
    setRenderer(choice === '3d' && !webglAvailable() ? '2d' : choice);
  }, []);

  const choose = useCallback((next: Renderer) => {
    setRenderer(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A private-mode browser refusing storage must not break the switch.
    }
  }, []);

  if (renderer === null) {
    return <EmptyState title="Laying out the floor…" description="Checking what this browser can render." />;
  }

  if (renderer === '2d') {
    return (
      <>
        <OfficeFloor projectId={projectId} tabId={tabId} />
        <SwitchHint label="3D office" onClick={() => choose('3d')} />
      </>
    );
  }

  return (
    <Suspense
      fallback={<EmptyState title="Loading the office…" description="Fetching the 3D renderer." />}
    >
      <Office3D projectId={projectId} tabId={tabId} onUse2D={() => choose('2d')} />
    </Suspense>
  );
}

/** The 2D floor owns its whole surface, so the way back to 3D floats over it. */
function SwitchHint({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-3 left-3 z-10 rounded-lg border border-white/10 bg-[#12151c]/90 px-2 py-1 text-xs text-slate-300 backdrop-blur hover:text-slate-100"
    >
      {label}
    </button>
  );
}
