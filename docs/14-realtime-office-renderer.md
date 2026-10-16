# 14: The realtime office renderer

Status: implemented (browser), cloud path designed only.
Related: [`09-ui-ux-spec.md`](09-ui-ux-spec.md), [`07-observability.md`](07-observability.md),
[`10-data-model.md`](10-data-model.md), [`11-api-and-event-contract.md`](11-api-and-event-contract.md).

## 1. The one idea

**The office is a projection of the event log, and the renderer knows nothing about the domain.**

Everything visible on the floor, who is at a desk, who is walking to the review table, who has
walked into the orchestrator's office because something is blocked, who is in the coffee corner
because they have been idle too long, is derived from real domain state. There is no decorative
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
| Activity | `sim/activity.ts` | agent, its task, its recent events | `Activity`, a pose kind, a bubble, a human sentence, and *where they should be* | yes |
| Target | `sim/targets.ts` | activities + tasks + floor plan | `Target`, a concrete point plus the reason | yes |
| Frame | `sim/scene.ts` | floor plan + activities + targets + tasks | `SceneState`, one serialisable frame | yes |
| Characters | `features/characters/look.ts`, `sim`-free | agent id + role + grade | a stable appearance | yes |
| Department pulse | `sim/rooms.ts` | floor plan + activities + events | production, shipments and newness per room | yes |
| Rig + render | `office3d/*`, `office/*` | the frame above | pixels | ⬜ deliberately thin |

Precedence is explicit and documented in `ACTIVITY_ORDER`: something wrong (`blocked`, `waiting`)
outranks something active (`typing`, `tool`, `talking`, `walking`), which outranks idle. Movement
carries meaning, an escalation walks to the orchestrator, verification walks to the shared table,
a task owned by another department walks you across the floor to it.

### Two cadences

The floor plan (`sim/floorplan.ts`) is *static*: it only changes when the organization changes.
`SceneState` is *dynamic*: rebuilt every second. Keeping them separate is what will let the cloud
version push a floor plan once and then stream small per-tick frames.

## 3. Layer boundaries: and what moves to the cloud

```
src/sim/            pure, framework-free, deterministic          ← portable as-is
src/app/useSceneFrame.ts   the one seam: domain → scene frame    ← becomes a subscription
src/features/office3d/     three.js renderer                     ← unchanged
src/features/office/       the 2.5D floor: projection, props, bubbles ← unchanged
src/features/characters/   the cast that both renderers draw        ← unchanged
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

- One frame per second per project is enough, the client interpolates movement between frames
  from the `intent`, which is why `SceneState` carries *destinations* rather than positions.
- Deltas: a frame is ~1.5 KB of JSON for 24 agents. At scale, send only changed agents plus a
  monotonically increasing `seq`, and full state on reconnect (the pattern already used by
  `docs/11` §4 for events).
- A project's scene worker is a pure function of its event log, so a restart replays to the same
  frame. `docs/07` §5's replay guarantee extends to the picture on screen.
- Isolation: one worker per project, no shared mutable state; the projector touches only that
  project's org, tasks and events.

## 4. Characters: procedural, deterministic, unencumbered

`office3d/characters.ts` generates a person from their agent id, skin tone, hair style and colour,
build, clothing, dress code, glasses, headsets, caps, lanyard.

Why generated rather than downloaded: **no licensed assets and no hundreds of megabytes of binaries
in a public repository**, infinite variation, and no dependency on a CDN at runtime. Everything,
including every texture, is drawn in code (`scenery.tsx`) or built from shared primitives
(`assets.ts`).

Determinism is the point: the same agent looks the same on every reload and on every machine, which
is what turns a crowd into *your* team. Appearance variation is deliberately **decorrelated from
role**, so the org chart does not turn into a set of stereotypes. Only genuinely occupational things
follow the role, a lab coat for QA, hi-vis for facilities, a headset for support, a dress code that
steps up with seniority, which is what a real company actually looks like.

### One cast, two renderers

The identity above is shared: `features/characters/look.ts` is read by both the
WebGL office and the 2.5D floor, and the pose table is shared as well, so the
person at a desk in one view is the person in the other, walking the same way.

The 2.5D floor draws each of them as **SVG** (`features/characters/SvgCharacter.tsx`):
chibi proportions with a big head and stubby limbs, one soft outline for the whole
cast, big eyes, a small smile and a blush. Those choices are what make a figure
likeable at 70 pixels tall. Cuteness is treated as a constraint rather than a hope,
the head is a tested fraction of the body, variation between people is deliberately
damped so a floor reads as one cast, and the seated fold is *derived* so the sole
always lands on the floor line.

This is the default view: it needs no GPU, it is crisp at any zoom, and it is the
surface that has to sell the product at a glance. The WebGL office is one click
away.

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
- The renderer is **lazy-loaded** (`OfficeTab`), so three.js never lands in the initial bundle,
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

1. **Now**, single-tenant rendering in the browser from the same event log the UI already has.
2. **Seats and rooms as data**, move desks/furniture into the org model so an org can be laid out
   by policy rather than by packing algorithm.
3. **Scene worker per project**, move `useSceneFrame`'s composition server-side and stream
   `SceneState` over the existing WebSocket. Client changes: one file.
4. **Multi-tenant**, scope workers by project, send only authorized fields (a viewer should not
   receive another tenant's spend figures), and rate-limit per connection.
5. **Rich behaviour**, meetings, pairing, day cycle, and the council convening at
   the table, all driven by real events rather than timers.

## 9. What people do to each other

A floor of individuals working alone is not a company. Three behaviours make the
organization social, and each one is traceable to something the system actually
did:

| Behaviour | Grounded in | On the floor |
|---|---|---|
| Asking a colleague | the harness's `ask_colleague` tool, recorded as `agent.message` with `{to, text, direction}` | the asker walks across the floor to that person and turns to face them |
| Pairing | a task assigned to a **squad** (a task has one `assignee_agent_id`, so a squad is how several people genuinely share a job) | juniors gather at the most senior member's desk, and disperse the moment the task ends |
| Gathering | several people sharing a destination | they spread onto a ring and turn inward, so the review table and the coffee corner read as conversations |

The honesty rule applies here more than anywhere, because social behaviour is
where a simulation is most tempted to fake it:

- A name the system did not recognise resolves to **nothing**, and the character
  stays at their desk. Inventing a recipient would put someone on the floor who
  was never spoken to.
- Pairing cannot invent collaboration: it requires a live squad task, so it
  appears with the work and disappears with it.
- Bubbles carry the real event text or nothing at all. There is no chatter track.
- Precedence still wins: something wrong (an escalation, a blocked task) outranks
  a conversation, so an agent on their way to the orchestrator is not shown
  cheerfully chatting.

`resolvePeer`, `pairAnchor` and the inward-facing rings are pure and tested in `src/sim/social.test.ts`.

## 10. Why the floor is drawn isometrically

The first 2.5D attempt tilted a CSS 3D plane and counter-rotated each character to stand up in it.
It looked wrong, and the reason is worth writing down: **a tilted plane forecloses the vertical
axis.** Everything drawn in it is foreshortened, so a standing figure reads as lying down and desks
read as floor tiles. No amount of fiddling with the counter-rotation fixes that, because the problem
is the projection, not the sprite.

`features/office/iso.ts` replaces it with a dimetric projection calculated in code:

```
screen.x = (worldX − worldY) · 1
screen.y = (worldX + worldY) · 0.5 − height
```

Verticals stay vertical. A character is drawn upright because there is nothing to rotate, and a
height is a real screen height. That single property is what makes the scene read as a place.

**Everything solid is a volume.** `boxFaces()` returns three polygons for any box on the floor, a lit
top face and two shaded sides, and every prop in `office/props.tsx` is built from that. The contrast
between the faces is what makes a monitor read as a monitor. Sizes come from metres: `mh(0.74)` is
desk height, `mh(1.5)` is a person, and the character's on-screen size is derived from the same
scale, so people are correctly bigger than the furniture.

The camera is a plain translate + scale. There is one projection, so there are no camera presets any
more; `fitCamera()` frames the whole building, signage included, and the department chips zoom to a
room. Painting order is far-to-near by `x + y`, which is the depth order this projection implies.

## 11. What the floor says about the organization

Three things are drawn on top of the simulation, and each one is a fact from the log:

| Marker | Grounded in | Where it appears |
|---|---|---|
| Bubble colour | the event's own type and payload (`direction`, `informal`) | above the speaker's head |
| "producing" | at least one agent in the room is typing or running a tool | pulsing pill on the department board |
| "✓ n shipped · <title>" | `task.completed` events for that room's agents, inside a 20-minute window | under the department name |
| "new" | an `org.department.created` event, or a room that the session has not seen before | on the department board |
| Walk to the boss | the org tree's own `manager_id`, a real command chain, not a guess | a character walking to a real desk |

Speech bubbles are the clearest example of the honesty rule. The colour and the badge come from what
the message *is*: an escalation is red with a `!`, a report upward is green with a `↑`, a directive
coming down is violet with a `↓`, a hand-off is blue with a `→`, work talk is white, and chat between
colleagues who are not working on anything is amber with a `☕`. The words are always the event's own
text, `textOf()` reads `payload.text` and nothing else, and when there is no text there is no bubble
rather than a plausible-looking one.

What a "squad" is, and why pairing needs one, is in §9. What this system cannot honestly claim is also
in §9: it never invents a recipient, never invents collaboration, and never invents conversation.

## 12. Furniture is derived from the pose table, not eyeballed

A character who sits in mid-air next to their own chair is not a styling problem, it is an arithmetic
one. The pose table is the single source of truth for a body's measurements, so the furniture that
holds a body is built from it:

| Rule | Why |
|---|---|
| A chair's seat top is `mh(HIP_SIT)`, 0.5 m, and the chair is centred on the sitter | the pose table puts a seated body's hips there; anywhere else and they float |
| Only the desk's owner is ever drawn seated | `Target.seated` is set for your own desk and for a break chair, and for nothing else |
| A monitor is lit only while its owner is typing or running a tool | one agent, one desk, one computer: a glance tells you who is actually computing |
| The break corner's chairs come from `breakSeats()` | the simulation seats people on that list and the renderer draws chairs from it, so the two cannot disagree |
| A shared table is stated, never dramatised | "on a break with <names>" is a fact; what they said is not knowable and is not invented |

The same discipline applies to the drawing itself. Height is a real screen height in this projection,
so a horizontal edge that dips below the eyes is a band across the face, the hair cap's lower edge is
tested by eye against the eye line, and the eyes are drawn without brows because at the size a floor
of characters is actually seen, brows plus a fringe read as one dark bar.

## 13. Rooms the organization asks for

Three of the floor's rooms are not decoration; they exist because the org said so, and people use
them because of what the log says they are doing.

| Room | Exists when | Used when |
|---|---|---|
| **Lab** | a department's name or mission reads as research | an agent's current task reads as research (`benchmark`, `experiment`, `analysis`, `prototype`, `study`, `measure`…), and the reason names the task |
| **Break corner** | always | somebody has been genuinely idle past the threshold: chairs first, then the two ends of the foosball table, then the vending machine queue, then the counter |
| **Review table** | always | a task is in `verifying` |

The break corner is one layout, not two. `breakLayout()` in the floor plan returns the tables, the
vending machine, its queue spots, the foosball table and its two ends; the simulation seats people on
those points and the renderer draws the props that own them, so they cannot drift apart. What is said
about somebody there is a fact and nothing more, "on a break with <names>" or "playing foosball with
<name>", because two idle people standing at a table is knowable and a conversation is not.

**Poses are chosen by movement, not by intent.** `walking` is a destination as well as a pose: an agent
sent to the review table keeps that activity after it arrives. The rig therefore plays the walk cycle
only while the walker is actually moving, or the whole floor walks on the spot.

**Hair, not helmets.** Hair comes in two sets chosen by a recognisable first name (else derived from
the agent id, so it is stable), across a palette that spans black through blonde and ginger to grey.
Two details matter more than the palette: the fringe must clear the eye line, and a dark dome needs a
highlight and a part line, or a head reads as a hard hat. An actual hard hat is issued kit for the
roles that need one, never a random draw.
