# The office's visual audit

A record of the loop this file belongs to: inspect the floor to the pixel, name every
defect with the evidence that found it, fix it, re-measure, repeat until nothing is
left that anybody can point at.

The scene is the product's face. It is also the one part of this repo that no test
can see by itself, which is why every item here is written as *evidence first*: a
measurement in the running app, a number read out of the atlas, or a pixel dump.
"The code looks right" is what produced all of these.

Rounds are appended; a defect is only crossed off when something measurably stops
being wrong.

---

## Round 1 — the sprite scale (found by measuring the running DOM)

### S1 · People were drawn three times too small ✔ fixed

**Evidence.** With the office open, every character's clip rect in the DOM was
`24×40` — i.e. the atlas cell at a factor of 1.0 units per sprite pixel — while the
desks in the same view were `146×204`, a factor of 3.04. A figure was therefore
40 world units tall: **0.56 m**, next to a desk two metres wide. The screenshot
showed it: doll-sized people at full-size desks.

**Cause.** Two rules for one thing. `Sprite` used `SPRITE_UNIT × view × scale`;
`SpriteCharacter` took a `height` from its caller and computed `(height / 40) × view`.
`FEET_Y` — the caller's value — was a leftover from the hand-drawn vector rig's 24×40
box, and no longer meant anything in the atlas's metres.

**Fix.** One rule. `SpriteCharacter` draws at `SPRITE_UNIT × view`, exactly like a
prop, and the `height` prop is gone.

### S2 · The atlas measured a metre two different ways ✔ fixed

**Evidence.** `world.pixelsPerMetre` said 32; `world.heightPixelsPerMetre` said 24.
One sprite pixel could not be both. Any renderer honouring the floor scale drew
everything 1.5× too tall; honouring the height scale drew everything 1.33× too wide.
The floor renderer's `SPRITE_UNIT` avoided both by deriving a third number from the
tile size, and the view's default of `0.68` — a hand-chosen fudge, not a preference —
then papered over the difference.

**The relation.** For one uniform pixels→units factor to serve both axes, the tile
must be exactly twice the height-metre: a 1 m tile projects to `TW` px of width and
costs `2 × unitsPerMetre` of world width, while 1 m of height is `M` px and costs
`unitsPerMetre`. So `TW / M = 2`. With the character rig hand-drawn at `M = 24`, that
fixes `TW = 48`, `TH = 24`.

**Fix.** The generator's tile is 48×24, the manifest declares `pixelsPerMetre: 24` for
both axes, and `SPRITE_UNIT = UNITS_PER_METRE / ATLAS.world.pixelsPerMetre` — derived
from the manifest instead of recomputed. The view scale is now a preference again:
`compact ×0.75 / to scale ×1.00 (default) / large ×1.5`, with a new storage key,
because the old one stored a number that meant something else.

### S3 · Furniture was drawn bigger than the bays it stood in ✔ fixed

**Evidence.** The desk sprite covered a **2 × 1 m** footprint (`prop(2, 1, …)`) in a
1.45 × 1.28 m bay, the chair a whole square metre, the lab bench 2 × 1 m. At the one
honest scale, every desk overhung its neighbours' partitions. "The office is crowded"
was never the floor plan: it was the furniture.

**Fix.** Desk 1.4 × 0.7 m, chair 0.6 × 0.6 m, plant 0.7 × 0.7 m, lab bench 2 × 0.7 m —
real sizes, so a bay now holds a desk, a chair and legroom without negotiation.

### S4 · `tileCentre` assumed a 1×1 footprint ✔ fixed

**Evidence.** `tileCentre(oy) = oy + TH / 2` is the centre of a footprint whose depth
is exactly one tile. The chair is now 0.6 tiles, so its seat was drawn
`(1 − 0.6) × TH / 2 = 4.8 px` — 20 cm — south of where the simulation seats the body.

**Fix.** `footprintCentre(oy, a, b)`, used by every prop that is drawn around its own
centre rather than its corner: chair, round table, stool, plant, centrifuge.

### S5 · The simulation and the renderer each owned the desk seat ✔ fixed

**Evidence.** `floorplan.deskOf` placed the body at `desk.y + DESK_H − 30`; `props.tsx`
placed the chair at `DESK_H − (DESK_SLAB_D / 2 + UNITS_PER_METRE / 2 − 6)`. They agreed
to within 3 units — by luck, from two hand-picked numbers whose origins are gone.
`DESK_SLAB_D = 58` was in neither the art nor the plan.

**Fix.** One function, `deskSeat(room, desk)`, in the floor plan: the bay's far edge
plus the desk's real depth plus a few centimetres of legroom. The simulation walks
bodies there and the renderer draws the chair there.

### S6 · Call sites multiplied the view factor by hand ✔ fixed

**Evidence.** `Chair` passed `scale={0.68}` while the view factor was also 0.68, so
chairs were drawn at 46% of the art. `Whiteboard` divided by `2 × UNITS_PER_METRE`
— a width the art does not have (its cell is 1.19 m of board) — and `MeetingTable`
and `RoundTable` divided by hand-typed art widths too. Every one of them was wrong by
the view factor, and would have been wrong again the moment the view changed.

**Fix.** `scaleForWidth(name, units)` reads the width out of the atlas entry, so a
caller asking for "a board this wide" cannot be surprised by the art changing.

### S7 · The desk sprite was offset by a metre that was not its own ✔ fixed

**Evidence.** `Workstation` placed the desk at `x + DESK_W/2 − UNITS_PER_METRE`, an
offset derived from the art's *declared* half-footprint — while the art was drawn at
0.68 of that. The desk sat 0.32 m north-west of its own bay, and the chair, which came
from the bay, was no longer under it.

**Fix.** A sprite is anchored at its footprint's far corner — the same corner as the
bay. The desk is placed at the bay's origin, at scale 1, and the geometry follows
instead of compensating.

### S8 · The measuring harness cried wolf ✔ fixed

**Evidence.** The first audit script expected a prop's cell to end at
`ay + (w / TW) × TH / 2` below the anchor, and flagged all ten props. The footprint's
drop below the anchor is `w / 2` px, because the cell's width *is* the footprint's
diamond. A harness with a wrong formula is worse than no harness: it teaches you to
ignore it.

**Fix.** `src/audit1.ts` measures the right thing, and reports what it actually saw
(px, metres at both readings of a metre, art below the anchor) rather than a verdict.

---

## Round 1b — the same round, looked at

Numbers can be right and the screen still wrong. These were found by zooming to
~90% and reading the picture, which is the only instrument that works on composition.

### S9 · A plant drawn through a workstation ✔ fixed

**Evidence.** Every department's corner plant sat at `room.w − ROOM_PAD − 14`,
`room.h − 26` — inside the desk grid. A green mass on top of the last bay's desk, in
every room that had one.

**Cause.** Nothing owned the room's spare space. `roomSize()` reserves a header band
(`ROOM_PAD + ROOM_HEADER`) above the first row of desks and nothing else, and the
corner is not spare: it is where the grid ends.

**Fix.** The plant stands in the header strip, which is the part of a room that is
reserved for exactly this.

### S10 · A row of chairs 20 cm clear of its own table ✔ fixed

**Evidence.** Caught by looking at the review table after S7 moved the table onto its
own footprint: the chairs, which were offset by the caller's hand-written `d`, no
longer touched it.

**Cause.** The caller describes the table as a bay (`w × d`); the art is 3 × 1 m
scaled to `w`. The two depths differ, and the chairs were placed from the caller's.

**Fix.** `spriteFootprint()` — the footprint is now in the manifest (S11), so a chair
is placed against the art's own near and far edges.

### S11 · The manifest carried no footprint ✔ fixed

**Evidence.** Three separate defects in this round were "a caller guessed the art's
size": a chair's half-footprint typed by hand, a board divided by a `2` that was 17%
wrong, a table's chairs offset from a bay instead of the table. Each was individually
fixable and all three had one cause.

**Fix.** `prop()` already knew the footprint it was drawing on; it now returns it, the
packer carries it, and the manifest declares `a`/`b` in tiles for every prop. A
character declares none, because a character's footprint is the point it stands on.
`spriteFootprint()`, `spriteCentreOffset()` and `scaleForWidth()` read it.

### S12 · Sizes and tones that were wrong at a glance ✔ fixed

- Foosball table 2 × 1.2 m → 1.4 × 0.8 m. It filled the corner it stood in.
- The reagent shelf was `mist` — the brightest object on the floor, a lightbox beside
  the bench. Now steel and iron, with the bottles as the only colour on it.
- The centrifuge's window was `coal`: a black disc on a light lid, i.e. a hole. Glass
  is `sky`.
- A chair's back was `ash,1` — near-invisible on a slate floor. `steel,2`.
- A turned chair's back, a white lab worktop, and the review room's board: all read as
  the brightest or darkest thing in their room, and all are now in the middle range
  the rest of the floor lives in.

### S16 · Two props only the sheet could show ✔ fixed

Found by rendering all 28 props at 4× on one card and looking at them. Neither is
visible in the office at any zoom: among forty sprites, a hood is a hood.

- **The fume hood's sash was a solid cyan block.** The glass was drawn as `sky` — full
  brightness — over the dark opening, so the hood read as a lit display case. Glass at
  this size is a dark cool pane with one pale edge.
- **The turned chair was a shapeless mass.** Its top rail and edge were one pixel
  each and vanished against the panel, so a chair back read as a grey lump sitting on
  the floor. Two pixels of rail and a lit left edge give it a silhouette.

Also verified clean on the sheet, so the audit is not a rumour: all three desks,
both chairs (unturned), the cabinet, both plants, both partitions, both long tables,
the round table, crates, the vending machine, the water cooler, the coffee machine,
the foosball table, the whiteboard, the desk lamp, spares, the lab bench, the
microscope, the stool, the reagent shelf and the centrifuge.

### S17 · The cast sheet: one real defect, and it is a trap ✔ documented

All twelve facing×pose cells at 6×, plus eight characters side by side. The numbers
first: every cell is centred to within half a pixel of its own middle (art x 5–18 in a
24 px cell), every figure's feet are on the last row of the cell or above it in a
seated pose, and **both walk frames are 37 px tall and end on the same row** — the
arithmetic behind "no bobbing, no floating", asserted rather than eyeballed.

- **The side view's hair covers two thirds of the face** — it reads as a face with
  something over it. This is a real defect and it is not visible in the office:
  `SpriteCharacter` asks for `front` and `back` only, and says why in a comment. The
  cell stays in the atlas as a trap for the next caller. Recorded here rather than
  fixed, because fixing the profile rig means redrawing it, and nothing draws it.
- Everything else on the sheet is clean: no detached limbs, no floating hands, no
  helmet hair (the fringe still sits above the eye line), and the eight characters are
  distinguishable at a glance by hair, skin, shirt and glasses.

---

## Open, not yet fixed

- Three sprite items were once seen outside the building and never diagnosed.
- `belt` is a category the atlas has no sprites for: the conveyor is drawn as rails.
- Wall clock, doors and signage geometry have not been checked against the plan.
- The wall/floor shell is drawn by the floor renderer, not the atlas: its metre has
  never been measured against the sprites standing on it.
