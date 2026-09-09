# Spatial Hack starter — context for coding agents

One-day hackathon (World Labs × Tripo × mint.gg × Convex). Goal: ship a 2-minute demo by 6 PM. Bias to working code over abstractions.

This repo holds two halves: the **capture CLI** (`scripts/`, `tests/`) that turns a
phone capture into a World Labs room, and the **web app** (`src/`, `convex/`) that
renders it. `README.md` covers both; `HACKATHON_PLAN.md` has the product architecture.

## Read first
- `HACKATHON_PLAN.md` — product concept, architecture review, scope decisions
- `docs/ROOM_CREATION_WORKFLOW.md` — capture → world pipeline, people removal
- `docs/00-hackathon-prep-sheet.md` — event, tracks, judging, idea list, day plan
- `docs/01-worldlabs.md` — Marble World API (worlds → .spz splats + collider .glb), Spark renderer
- `docs/02-tripo.md` — Tripo v3 API (text/image → GLB, rig, convert). URLs expire in 5 min.
- `docs/03-mint.md` — mint.gg API/MCP + Three.js agent skills
- `docs/04-convex.md` — Convex concepts, components, multiplayer rules

## Stack
Vite + React 19 + TypeScript · react-three-fiber + drei · `@sparkjsdev/spark` (Gaussian splats) · Convex (backend, storage, realtime).
All third-party API calls happen in **Convex actions** (`convex/worlds.ts`, `convex/assets.ts`) so keys stay server-side. Generated assets are cached into Convex file storage; the client only ever loads Convex storage URLs.

## Commands
```
npm install
python3 -m pip install -r requirements-media.txt   # capture CLI media helpers
npm run world -- credits                           # World Labs CLI (needs WORLDLABS_API_KEY in .env.local)
npm test                                           # capture CLI + Convex/client integration tests
npx convex dev                     # first run: login + create deployment, writes .env.local
npx convex env set WLT_API_KEY ... ; npx convex env set TRIPO_API_KEY ... ; npx convex env set MINT_API_KEY ...
npx convex env set OPENROUTER_API_KEY ...          # optional: sketch orientation (see below)
npm run dev                        # convex dev + vite
```
Multiplayer test: open two tabs at `http://localhost:5173/?room=test`, click "join multiplayer" in both.

## Conventions
- Coordinates: Marble splats/colliders are OpenCV (+y down) → `scale=[s,-s,-s]` (via `worldTransform` in `SplatWorld.tsx`). Metric scale via `metricScale`/`groundOffset`, read off the world document — never hardcode them.
- GLB loading: always through `gltfLoader` in `src/components/Asset.tsx` (Draco + meshopt decoders attached).
- Multiplayer: one doc per player, ≤5–10 Hz mutations, lerp remote players. Never send per-frame mutations.
- Generation is slow (Tripo 10–120s, Marble 1–5 min): kick it off early, show status in UI, never block the render loop.
- Keep the demo path (`src/App.tsx`) working at all times; put experiments behind `?feature=` flags.

## Capture integration
`src/App.tsx` hosts the capture entry, then hands off to `src/WorldApp.tsx` — the
first-person room viewer. Everything generates live; there is no bundled/demo room and
no `?live=1` flag. Picking a photo or video uploads it to Convex storage and calls
`worlds.startFromMedia` (mutation), which inserts a `generating` world row and schedules
`internal.worlds.runFromMedia` to call Marble (`world_prompt.type: "image"|"video"`,
a `source: "uri"` reference in `image_prompt` / `video_prompt` pointing at the Convex storage URL), poll the operation, and cache the
splat/collider/pano into storage — the same `runGenerate` helper `generateFromText` uses.
`App.tsx` opens `WorldApp` with the returned ID immediately. Fast preview
(`marble-1.0-draft`) is the default; the capture quality selector offers `marble-1.1`.
`runFromMedia` submits once, stores the provider operation, and schedules short
`pollGeneration` actions every 3 seconds. Each attempt has a deadline (8 minutes
for draft, 15 for detail) and a watchdog, with matching deadline guards against
stale checks. `resumeGeneration` rechecks an existing operation without a new paid
POST. Required splat/collider downloads run concurrently; optional panorama caching
runs after readiness. The viewer reads the world `stage` reactively. Picking a
`.zip` instead goes through `src/lib/ConvexProjectClient.ts`, which unpacks
`readWorldZip` results into Convex storage via `api.worlds.importUploaded` — that path is
for a world already generated elsewhere, not a stand-in.

A corner "Existing worlds" button (`src/components/ExistingWorlds.tsx`) lists every world
in Convex (`api.worlds.list`) on both the landing screen and inside the room viewer, so a
previously generated room can be reopened without regenerating it. The URL's `world` is
the Convex ID and default room ID; legacy `job` URLs still import through
`ConvexProjectClient.importLocalWorld`, for captures the CLI saved locally under
`public/world-assets/` — that is a real bring-your-own-capture path, not a demo.

Root `vite.config.ts` serves only saved `/world-assets/` files, for those legacy `job`
URLs. `web/src/` is legacy code, not a second active viewer.

## The room viewer (`src/WorldApp.tsx`)
Navigation is first-person (`LocalWalk.tsx`: pointer lock, WASD/arrows, Q/E, Shift) — there
is no OrbitControls. Room geometry, the object library, placements and players all come from
Convex; nothing is stored in IndexedDB.

There are two modes and `H` is the whole switch between them: walking and drawing. Escape
drops pointer lock for the side panel (the browser does that itself); clicking the canvas
takes it back. `LocalWalk` ignores movement keys while `paused`, because placement rebinds
Q/E — do not remove that guard.

- Placement: `src/lib/surfacePick.ts` raycasts the Marble collider for a real triangle
  normal (inverse-transpose normal matrix, flipped toward the camera) and falls back to two
  probe rays against the splat. `plane` is disabled — a miss places nothing rather than
  inventing a depth. Do not "simplify" this; it is what makes objects land on tables.
- What that normal *means* is `src/lib/placementPose.ts`: floors stand the object up, walls
  put its back against them with world-up preserved, ceilings hang it. There is no override
  and no offset — the object sits exactly on the picked point, on whatever the cursor is over.
  `poseOnSurface` is called by the ghost preview and by the click that commits it, so the two
  cannot disagree. Splat normals are noisy, so they only count as a wall below `|n.y| < 0.35`.
- Editing a placed object *is* placement: clicking one (crosshair while walking, or the free
  cursor) re-arms it through the same `PlacementGhost` and it re-orients to whatever is under
  the cursor, like any other placement. Q/E turn, `[`/`]` resize, `R` resets the turn, Enter
  commits, Esc cancels.
- Sizes: `fit.ts` normalizes every GLB so its longest dimension is `targetSize` metres and
  its bottom-centre sits at the anchor. `PlacementGhost` and `Asset` run identical maths,
  so a committed object does not jump.
- Sketching: `DrawingLayer` freezes the frame; `drawingPlacement.ts` raycasts the base of the
  ink to a real surface (the centroid of the ink resting on it, not the bounding-box corner)
  and stores that contact point, the `orientOnSurface` rotation, the camera matrices and the
  strokes themselves. `fitDrawing` replays the matrices to estimate a size. While the mesh
  builds, `SketchGhost` hangs the ink alone back in the room on the quad `drawingQuad`
  unprojects from those same matrices; the cutout rides in the `localStorage` job entry and
  survives a reload, and over `STROKE_BUDGET` it is dropped rather than risking the quota.
- A finished mesh is **placed automatically** at its anchor — no click — then selected and
  pushed onto the undo stack, so the hanging `SketchGhost` (hidden once `jobPlaced`) dissolves
  into the real object in the same spot. `arm`/`PlacementGhost` remain for the library's Place
  button, for Move, and as the fallback when no pose can be derived.
- Sketch orientation: Klein re-poses the cutout into a centred product view, so the only record
  of the drawn viewpoint is the user's ink. `src/lib/sketchPose.ts` owns the whole decision as a
  three-rung ladder, each rung falling to the next on any failure — read it before changing any
  part of this:
  1. **Vision — opt-in via `?vision=1`, off by default.** `SketchSolver.renderViews` renders the
     mesh at 8 yaws as one numbered contact sheet, `renderInk` redraws the strokes, both upload
     to Convex storage, and `convex/orientation.ts` asks a vision model through OpenRouter which
     view matches. It is the rung that works when the mesh *isn't* a faithful likeness of the
     sketch — common, since Tripo builds from Klein's reinterpretation rather than from the ink
     — but two uploads and a round trip per object is too much latency to spend by default on
     top of a generation pipeline that already runs one to two minutes.
  2. **Chamfer.** `sketchOrientation.ts` (pure, injected renderer) chamfer-matches the ink
     against silhouettes swept by `SketchSolver`. With a `window` it searches only the sector
     the vision model picked; without one it sweeps the full circle and applies its confidence
     gate. `alignToBox` scales *uniformly* — the silhouette's aspect ratio is the yaw signal, so
     do not stretch it to fit. When no yaw beats the median by 15% the object is rotationally
     ambiguous.
  3. **Face the camera** — the yaw `orientOnSurface` already gave the anchor.
  `composeYaw` post-multiplies about the object's own +Y, the same convention as
  `poseOnSurface`'s manual yaw. Both renderers share one tiled render target and a single
  readback inside `<Canvas>`, and `renderAtlas` must restore every piece of renderer state it
  borrows — the viewport especially, or the whole app renders into a corner.
- The vision rung needs `?vision=1` **and** `OPENROUTER_API_KEY` on the deployment. Without the
  flag it is skipped silently (a normal placement); with the flag but no key the card says
  orientation matching is unavailable. `OPENROUTER_VISION_MODEL` overrides the default
  `google/gemini-3.8-flash` (~$0.005/sketch) with, say, `anthropic/claude-opus-5`.
  `convex/orientationResult.ts` holds the schema, prompt and a deliberately tolerant parser,
  with no Convex imports so `node --test` can exercise it.
- Undo/redo is an inverse-operation stack (`src/lib/placementHistory.ts`), not array
  snapshots: placements are shared, so replaying a snapshot would revert other players.

## Sketch -> object pipeline
`assets.startSketch` (mutation) validates keys, inserts the row, returns its id and
schedules `internal.sketch.run` (`"use node"`). That action reuses the CLI modules
verbatim — `scripts/image-benchmark/providers.mjs` for fal Klein + BiRefNet,
`scripts/glb-assets.mjs` for `inspectGlb`/`modelArtifact` — plus `convex/tripo.ts`, which
is a copy of the four Tripo helpers from `scripts/image-to-stl.mjs` (copied, not imported,
to keep three.js out of the Convex bundle). `convex/pipeline-modules.d.ts` types both JS
modules. Progress is patched onto the asset row, so the client watches it with `useQuery`
instead of polling. STL export runs in the browser (`src/lib/stlExport.ts`).

Every sketch generates for real — there is no demo stand-in and no `?live=1` flag.

Needs `FAL_KEY` and `TRIPO_API_KEY` in the Convex environment. The Tripo endpoint here is
`api.tripo3d.ai/v2/openapi`, not the `openapi.tripo3d.ai/v3` one used by the older
`assets.generateFromText`/`generateFromImage` actions.

## Where to extend
- NPC/agent: `npm i @convex-dev/agent ai @ai-sdk/anthropic`, enable in `convex/convex.config.ts`, add `convex/npc.ts`.
- Presence UI: `npm i @convex-dev/presence`.
- Physics/walking: `npm i @react-three/rapier`, use the collider GLB as a `TrimeshCollider`.
- First-person controls: drei `PointerLockControls` + raycast against `userData.collider` meshes for ground height.
- Mint assets: install `mintdotgg/mint-threejs-skills` and use `mint-assets.json` + sync script per the skill.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
