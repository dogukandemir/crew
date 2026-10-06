# 14 — The realtime office renderer

Status: implemented (browser), cloud path designed only.
Related: [`09-ui-ux-spec.md`](09-ui-ux-spec.md), [`07-observability.md`](07-observability.md),
[`10-data-model.md`](10-data-model.md), [`11-api-and-event-contract.md`](11-api-and-event-contract.md).

## 1. The one idea

**The office is a projection of the event log, and the renderer knows nothing about the domain.**

Everything visible on the floor — who is at a desk, who is walking to the review table, who has
walked into the orchestrator's office because something is blocked, who is in the coffee corner
because they have been idle too long — is derived from real domain state. There is no decorative
animation and no invented activity: if the floor looks busy, the organization is busy.

The second rule follows from the first: **the simulation never imports React or three.js.** It is
plain data in, plain data out. That is what makes the same simulation runnable in a browser tab
today and inside a cloud scene worker later, and it is what makes it testable without a GPU.

## 2. The pipeline

```
event log ─┐
tasks ─────┼─► Activity        ─► Target           ─► SceneState      ─► renderer
org tree ──┘   (pose + note)      (where + why)       (one frame)        (pixels)
```

| Stage | Module | Input | Output | Tested |
|---|---|---|---|---|
| Activity | `sim/activity.ts` | agent, its task, its recent events | `Activity` — a pose kind, a bubble, a human sentence, and *where they should be* | ✅ |
| Target | `sim/targets.ts` | activities + tasks + floor plan | `Target` — a concrete point plus the reason | ✅ |
| Frame | `sim/scene.ts` | floor plan + activities + targets + tasks | `SceneState` — one serialisable frame | ✅ |
| Characters | `office3d/characters.ts`, `sim`-free | agent id + role + grade | a stable appearance | ✅ |
| Rig + render | `office3d/*` | `SceneState` | pixels | ⬜ deliberately thin |

Precedence is explicit and documented in `ACTIVITY_ORDER`: something wrong (`blocked`, `waiting`)
outranks something active (`typing`, `tool`, `talking`, `walking`), which outranks idle. Movement
carries meaning — an escalation walks to the orchestrator, verification walks to the shared table,
a task owned by another department walks you across the floor to it.

### Two cadences

The floor plan (`sim/floorplan.ts`) is *static*: it only changes when the organization changes.
`SceneState` is *dynamic*: rebuilt every second. Keeping them separate is what will let the cloud
version push a floor plan once and then stream small per-tick frames.

## 3. Layer boundaries — and what moves to the cloud

```
src/sim/            pure, framework-free, deterministic          ← portable as-is
src/app/useSceneFrame.ts   the one seam: domain → scene frame    ← becomes a subscription
src/features/office3d/     three.js renderer                     ← unchanged
src/features/office/       2D fallback renderer                  ← unchanged
```

`useSceneFrame` composes the pure stages in the browser today. In the cloud it is replaced by a
`SceneState` subscription and nothing downstream changes. That is the entire migration.

### The scene contract

`SCENE_CONTRACT = 1` in `sim/scene.ts`. Additive changes are allowed; a breaking change bumps the
version, exactly like `docs/11` §5 for the REST/WS contract.

```ts
SceneState = { version, projectId, builtAt, agents: SceneAgent[], stats }
SceneAgent = { id, name, role, grade, state, activity, bubble, note,
               intent: { roomId, roomName, point }, fromRoomId, desk, homeRoomId,
               taskTitle, taskId }
```

There is a test that `SceneState` survives `JSON.parse(JSON.stringify(...))` unchanged, because the
whole point is that it is meant to cross a wire.

### Wire plan (not built yet)

- One frame per second per project is enough — the client interpolates movement between frames
  from the `intent`, which is why `SceneState` carries *destinations* rather than positions.
- Deltas: a frame is ~1.5 KB of JSON for 24 agents. At scale, send only changed agents plus a
  monotonically increasing `seq`, and full state on reconnect (the pattern already used by
  `docs/11` §4 for events).
- A project's scene worker is a pure function of its event log, so a restart replays to the same
  frame. `docs/07` §5's replay guarantee extends to the picture on screen.
- Isolation: one worker per project, no shared mutable state; the projector touches only that
  project's org, tasks and events.

## 4. Characters: procedural, deterministic, unencumbered

`office3d/characters.ts` generates a person from their agent id — skin tone, hair style and colour,
build, clothing, dress code, glasses, headsets, caps, lanyard.

Why generated rather than downloaded: **no licensed assets and no hundreds of megabytes of binaries
in a public repository**, infinite variation, and no dependency on a CDN at runtime. Everything —
including every texture — is drawn in code (`scenery.tsx`) or built from shared primitives
(`assets.ts`).

Determinism is the point: the same agent looks the same on every reload and on every machine, which
is what turns a crowd into *your* team. Appearance variation is deliberately **decorrelated from
role**, so the org chart does not turn into a set of stereotypes. Only genuinely occupational things
follow the role — a lab coat for QA, hi-vis for facilities, a headset for support, a dress code that
steps up with seniority, which is what a real company actually looks like.

## 5. Rendering

three.js via `@react-three/fiber`, with `@react-three/drei` for the orbit camera. Rules that keep a
floor of ~24 animated people at frame rate:

- **Shared geometry and cached materials.** One `BoxGeometry`, one capsule per body part, and
  materials cached by colour+roughness, so a hundred garments collapse into a couple of dozen
  materials rather than one GPU buffer per mesh.
- **Animation never re-renders React.** One `useFrame` per character writes limb rotations and the
  walk cycle straight onto the object graph. React re-renders only when *state* changes.
- One shadow-casting directional light; shadow-casting is off for accessories; `dpr` is capped at
  1.75 and antialiasing is left to the browser.
- The renderer is **lazy-loaded** (`OfficeTab`), so three.js never lands in the initial bundle —
  it is a separate ~264 KB gzip chunk fetched when the office first opens.

### WebGL is not guaranteed

`OfficeTab` probes for a usable context before rendering and falls back to the 2D floor plan
(`features/office/`), which needs no GPU and shows the same simulation. The choice is remembered and
switchable both ways from the HUD. A machine without a GPU, a headless browser, or a driver that
refuses a context would otherwise get a blank rectangle.

### Fallback of last resort

Both renderers consume the same `SceneState`, so a third one (a text list, a server-rendered SVG)
is a small addition rather than a new subsystem.

## 6. Testing

The pure layers are unit-tested: activities, targets, paths, walkers, the floor plan, the scene
projection, character generation, and the pose table (every activity has a pose, desk work is
seated, walking is upright, blends are safe). The renderer is deliberately thin and is verified by
driving the real app in a browser.

Two bugs the tests caught that review did not: `bald` was counted both as a hair style and as its
own branch in the character generator (firing ~19% of the time instead of 7%), and a duplicated
`distance` helper inside `walkers.ts`. Two bugs the screenshots caught: room props were being
double-translated by the room's own offset, and name plates were fixed-size in world space so
zooming in made them swallow the scene.

## 7. Known limits

- **Stylised, not photoreal.** Low-poly capsule humans with procedural faces. This is a deliberate
  licensing and repository-size decision (§4), not a temporary shortcut.
- **No pathfinding.** Walkers follow waypoint routes (door → corridor → door). They will clip
  furniture that is not a wall. Replacing this is a local change to `sim/paths.ts`.
- **No collision avoidance.** Two people heading the same way overlap.
- **`THREE.Clock` deprecation warning** comes from `@react-three/fiber` itself, not this code.
- The council/meeting-room behaviour from `docs/03` is not yet driven from the floor; today only
  two agents ever share a destination (escalation and review).

## 8. Roadmap toward the hosted product

1. **Now** — single-tenant rendering in the browser from the same event log the UI already has.
2. **Seats and rooms as data** — move desks/furniture into the org model so an org can be laid out
   by policy rather than by packing algorithm.
3. **Scene worker per project** — move `useSceneFrame`'s composition server-side and stream
   `SceneState` over the existing WebSocket. Client changes: one file.
4. **Multi-tenant** — scope workers by project, send only authorized fields (a viewer should not
   receive another tenant's spend figures), and rate-limit per connection.
5. **Rich behaviour** — meetings, pairing, day cycle, and the council convening at the table, all
   driven by real events rather than timers.
