/**
 * The office tab.
 *
 * There is one renderer. The WebGL office is gone: it carried three.js and a second
 * implementation of the same simulation, and the 2.5D floor is the one that reads as
 * a control room, departments you can name, routes you can follow, a cast that is
 * drawn rather than lit. Removing it also removed the probe for a usable WebGL
 * context, the remembering of which renderer you had chosen, and the button that
 * switched between them, because there is nothing left to choose.
 */
import { OfficeFloor } from './OfficeFloor';

export function OfficeTab({ projectId, tabId }: { projectId: string; tabId: string }) {
  return <OfficeFloor projectId={projectId} tabId={tabId} />;
}
