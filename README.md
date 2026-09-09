# doodleforge

> **One flow, end to end:** `npm install` → `npm run dev` → open
> [localhost:5173](http://localhost:5173). Choose a capture, step into the room, walk it
> with WASD, sketch an object into your view and place it on a real surface. See
> [Draw directly into the room](#draw-directly-into-the-room).


Capture the room you are standing in, explore a generated 3D version of it, sketch
objects into your view, and prepare what you like for a physical 3D print.
Product architecture and scope decisions are in [HACKATHON_PLAN.md](HACKATHON_PLAN.md).

The capture pipeline and app share a Convex import path:

| Part | Path | What it does |
| --- | --- | --- |
| Capture CLI | `scripts/`, `tests/` | Local World Labs capture-to-world pipeline. Turns a phone video or photos into a room splat + collider, checkpointed and resumable. |
| Web app | `src/`, `convex/` | React 19 + Three.js/Spark viewer that renders the room, with Convex for state, storage, and multiplayer. Third-party API calls run in Convex actions so keys stay server-side. |

`docs/` carries both the capture write-ups and the per-vendor API references.
See `CLAUDE.md` for the agent-oriented overview.

## High-quality room mesh

The completed stage room now also has a cleaned 16.17-million-triangle vertex-colored
mesh and a textured mesh, with approximate window-based scale calibration.
[Download the full HQ meshes and reports](https://github.com/ConstantinVictorBeatErtel/doodleforge/releases/tag/stage-hq-mesh-2026-09-05).
See [the export, cleanup and scale guide](docs/HIGH_QUALITY_MESH.md) for local viewing,
exact transforms and limitations. These are separate editing assets; the web app
continues to use its saved splat and collider. The meshes are not yet watertight for printing.

## Setup

The capture entry flow and room viewer live together in `src/`. Select a photo, short
video, or ZIP, then press **Create my world**. A photo or video uploads to Convex
storage and starts a real World Labs (Marble) generation — the room viewer opens
immediately and shows generation progress while it finishes in the background.
**Fast preview** is the default (Marble 1.0 Draft); choose **Higher detail** before
creating for Marble 1.1. Draft generation takes roughly 20 seconds after input
preparation; preparing a photo is roughly 30 seconds and video roughly 2 minutes.
Higher-detail world generation is roughly 5 minutes plus preparation. Upload,
queue, and asset-download time vary; these are provider estimates, not guarantees.
[World Labs timing guide](https://docs.worldlabs.ai/).

The backend checks progress every 3 seconds in scheduled actions, preserving the
operation ID across reloads. It downloads the 500k splat and collider concurrently,
then opens the room without waiting for its optional panorama thumbnail. Failed
downloads never count as usable room assets. After 8 minutes for a fast preview or
15 for higher detail, the UI offers **Resume generation** to check the same saved
operation; it does not submit another paid generation. A provider-declared failure
requires a new capture attempt instead. Generating and failed rooms can be reopened
from **Existing worlds** to check progress or resume.

A `.zip` (a world already generated elsewhere, e.g. via the
capture CLI or a Marble export) is unpacked in the browser and imported with no wait
and no provider call. Native phone photo/video capture buttons are also available.

The URL becomes `?world=<Convex ID>` so refresh resumes the same room. The **Existing
worlds** corner button (on the entry screen and inside the room) lists every world
already generated and stored in Convex, so you can reopen one without generating again.
Legacy `?job=...` links still import saved local worlds (from the capture CLI) into the
same app via `ConvexProjectClient`.

```sh
npm install
CONVEX_AGENT_MODE=anonymous npx convex dev  # dedicated local backend; keep running
# In another terminal:
npm run web
```

The Convex command writes the ignored `.env.local` configuration. `npm run web`
serves the canonical root app; the commands in `web/` forward to it for compatibility.
The older `web/src/` standalone implementation is no longer the active UI. The
read-only `/world-assets/` route serves saved manifests and assets, never the CLI
or generation credentials. Local Convex data and room binaries are not committed.

Requires Node 22+ and Python 3 (HEIC conversion uses macOS `sips`).

```sh
npm install
python3 -m pip install -r requirements-media.txt
cp .env.example .env.local
```

Set `WORLDLABS_API_KEY` in `.env.local` using a key from
[World Labs Platform](https://platform.worldlabs.ai). API billing is separate from
Marble website credits. Keep the key server-side. `.env.local`, captures, and
downloaded worlds are ignored by Git.

## Capture a room

```sh
npm run world -- credits
python3 scripts/prepare_capture.py /absolute/path/to/capture.MOV
npm run world -- generate --input data/captures/prepared/capture.mp4 --job room-01 --dry-run
npm run world -- generate --input data/captures/prepared/capture.mp4 --job room-01
```

`generate` spends API credits. Its default model is `marble-1.1-plus`; video and
multi-image generation are currently 1,600–3,100 credits ($1.28–$2.48). The CLI
requires enough prepaid balance for the documented maximum before submitting. This
is a local preflight, not a provider spending cap; simultaneous usage elsewhere can
change the balance. `--model marble-1.1` is a fixed 1,600-credit video/multi-image
alternative. [Pricing](https://docs.worldlabs.ai/api/pricing).

The initial authorized run uses `data/captures/prepared/IMG_6872.mp4`, job
`hackathon-room-video-01`. Inspect or resume it with:

```sh
npm run world -- resume --job hackathon-room-video-01
```

This run completed successfully.
[Result and quality assessment](docs/FIRST_WORLD_RESULT.md).
[Download the full room and prepared captures](https://github.com/ConstantinVictorBeatErtel/doodleforge/releases/tag/room-capture-2026-09-05).
The release includes the full-resolution splat and all other returned room assets.
[Capture-to-world workflow and people removal](docs/ROOM_CREATION_WORKFLOW.md).
The original room contains people. The user subsequently supplied a stage-view
capture and authorized proceeding: `hackathon-stage-no-people-01` is complete,
using five cleaned photos. Its panorama shows no visible people and faces into
the hall from the demo stage.
[Open the stage world](https://marble.worldlabs.ai/world/82f39764-5224-4574-8328-8a747f42ed3e),
[download its full assets and cleaned inputs](https://github.com/ConstantinVictorBeatErtel/doodleforge/releases/tag/stage-room-2026-09-05),
or read the [generation and quality record](docs/STAGE_WORLD_RESULT.md).

The latest version adds three cleaned rear-stage photos, completing an eight-view
reconstruction with the screen, cabinet, exit sign and plants behind the stage.
[Open the updated room](https://marble.worldlabs.ai/world/262dd7ba-d156-46a1-8445-f62bc60e1265),
[download full assets and all inputs](https://github.com/ConstantinVictorBeatErtel/doodleforge/releases/tag/stage-rear-2026-09-05),
or read the [rear capture and quality record](docs/STAGE_REAR_UPDATE.md).
No people are visible in its panorama; physical calibration and browser navigation
remain unverified.

The CLI waits up to 20 minutes by default. `--wait 0` submits and checks once;
`resume` continues polling/downloading using the saved operation, without creating
another world. `--poll` accepts 1–60 seconds. A completed job exits immediately.

### Other input modes

Single image:

```sh
npm run world -- generate --input data/captures/prepared/IMG_6879.jpg --job room-image-01
```

Multiple images of one space, in reconstruction mode:

```sh
npm run world -- generate \
  --input data/captures/prepared/IMG_6873.jpg \
  --input data/captures/prepared/IMG_6874.jpg \
  --input data/captures/prepared/IMG_6875.jpg \
  --input data/captures/prepared/IMG_6876.jpg \
  --job room-photos-01 --dry-run
```

Accepts 2–8 images with identical dimensions. No fabricated azimuths are supplied.
One video and multiple images are separate API input modes; videos are not
concatenated or mixed with stills. Single-image inputs are explicitly treated as
ordinary photos, not panoramas. Text-only, panorama, and HQ mesh export workflows
are outside this first implementation.

### Outputs

Each job creates `data/worlds/JOB/`:

- `job.json`: input hashes, uploaded media IDs, exact generation request, operation ID, status, and before/after credit observations.
- `world.json`: original provider response, including asset URLs and semantics.
- `manifest.json`: portable integration record with relative asset paths, byte sizes, SHA-256 checksums, model, world ID, and coordinate metadata.
- `assets/`: all returned SPZ resolutions (the first run includes 100k, 150k, 500k, and full resolution); GLB collider; panorama; thumbnail (when returned).

Working files remain local and ignored by Git. The first room's binary assets and
prepared inputs are also distributed in the public GitHub release linked above, as
requested; raw provider responses and credentials remain local. To display a world
later, store the assets in the chosen application storage and map manifest paths to
URLs. Start the laptop viewer with the 500k SPZ in Three.js + Spark; keep the
collider separate. No provider key is needed to render already downloaded assets.

`splatToApp` applies provider metric scale, then ground offset, then a 180-degree X
rotation. It is a column-major matrix. Missing/invalid metadata produces a null
matrix. `colliderToApp` deliberately stays null until collider/splat landmark
alignment is verified. `calibration: unmeasured` means provider metric metadata has
not been checked against physical measurements. Do not enable measured placement
just because the generation succeeded.
[Rendering reference](https://docs.worldlabs.ai/api/rendering-spz).

### Failure recovery

Uploads and downloads are checkpointed; completed downloads are reused after
checking their hashes. Generation POSTs are not automatically retried. If a request
timed out after submission, `job.json` remains `submitting` and the CLI refuses to
submit again. Inspect the Platform for that operation and attach it:

```sh
npm run world -- resume --job room-01 --operation OPERATION_ID
```

Only attach the operation belonging to that capture. Failed provider operations
remain failed; a new job name is an explicit new paid attempt. If the CLI is killed,
a `.lock` file can remain; verify its recorded PID is no longer running before
removing it. This local CLI is not yet a shared job queue.

## Run the web app

### The room viewer

`npm run dev` starts Convex and Vite together; `npm run web` serves the app alone
against an already-running deployment. There is one entry point and one viewer: the
capture screen at `/`, which opens the room in place.

- Click the room to capture the mouse for 360° looking; **H** releases it. WASD/arrows
  walk, Q/E change elevation, Shift speeds up. Movement is in metres — the room carries
  Marble's metric scale.
- **Draw an object** freezes the view and overlays your exact current frame. Sketch the
  object with its base touching a table, floor or wall; the green dot marks the contact
  point, and nothing is generated without a real surface hit.
- A finished object arrives in your hand at the size the sketch implies. Move the cursor
  over the room to preview placement and click to commit; scroll to resize, Esc or
  right-click to cancel.
- Select a placed object to move, resize, rotate, place another instance or remove it.
  Undo and redo cover placements and edits made in this session.
- Objects and placements live in Convex, so they survive a reload and every player in
  the room sees them. **Join multiplayer** publishes your position to the same room.

Placement prefers the room collider and falls back to splat raycasting. No guessed
ground plane is used: if neither answers, nothing is placed. **Show room collider**
draws the wireframe so you can check it lines up with the splat before trusting a
placement. `?debug=1` adds sliders for the room transform. Coordinates and object sizes
are in room metres; this is visual placement, not a physical calibration.

### Convex application

```sh
npx convex dev            # login, creates deployment, writes .env.local (VITE_CONVEX_URL)
npx convex env set WLT_API_KEY <key>
npx convex env set TRIPO_API_KEY <key>
npx convex env set FAL_KEY <key>  # required for sketch-to-object generation
npm run dev               # http://localhost:5173/?room=lobby
```

Use this account-backed setup instead of the anonymous local backend when sharing
one Convex deployment. Backend secrets are set on that deployment, not read from
`.env.local`. Importing saved rooms needs no provider keys; the original World Labs
and Tripo generation buttons do. Deploy the updated Convex functions with
`npx convex dev` before connecting another checkout.

The selected world ID is also the default placement/multiplayer room; an explicit
`?room=...` still overrides it. To test multiplayer, open the same world URL in two
different browsers and click **join multiplayer** in each (tabs in one browser
share a session ID).

## Tests

```sh
npm test
npm run build
python3 scripts/verify_world.py data/worlds/hackathon-room-video-01
```

Tests cover request mode validation, coordinate transforms, API credential
isolation, generation/download/resume behavior, corrupted download recovery,
insufficient credits, provider failures, and ambiguous submission handling. Vitest
also verifies local-manifest and ZIP imports into Convex, duplicate import
prevention, retry behavior, and shared world IDs for placement and multiplayer. The
verifier checks saved checksums, SPZ headers (and gzip CRC for legacy files), GLB
structure, and image decoding. Capture assessment and source links:
[docs/CAPTURE_REVIEW.md](docs/CAPTURE_REVIEW.md).


## Draw directly into the room

Sketching runs the colour pipeline inside Convex, so the keys stay server-side and the
finished object is shared with everyone in the room:

```sh
npx convex env set FAL_KEY <key>        # fal: image edit + background removal
npx convex env set TRIPO_API_KEY <key>  # Tripo: textured P1 models
npx convex env set OPENROUTER_API_KEY <key>  # optional: `?vision=1` only, off by default
npm run dev
```

`assets.startSketch` stores the two screenshots, inserts the object row and returns its
id immediately; `sketch.run` then does the paid work on the scheduler:

1. **Image** — fal FLUX.2 Klein 9B edits your annotated frame into a clean isolated object.
2. **Cutout** — fal BiRefNet removes the background; a PNG with no transparent or no
   visible pixels is rejected before any 3D task is submitted.
3. **3D + color** — Tripo P1 `image_to_model` with `texture: true`,
   `texture_alignment: original_image`, PBR maps off. The task ID is saved *before*
   polling starts, so a reload or retry resumes it rather than paying twice.
4. The GLB is checked for a connected base-colour texture or vertex colours — a grey
   base mesh is refused — and stored in Convex.

Progress is written onto the object row, so the card in the viewer updates reactively
with no polling. A failed job keeps its task ID and offers **Resume task**. Print copies
are exported in the browser: **STL · no color** converts the GLB to a 100 mm-tall,
bed-centred, Z-up binary STL without touching the canonical colour GLB.

The sketch's bottom-centre ray, its saved camera projection and the generated mesh
bounds suggest an initial size. Final position comes from the surface under the cursor
when you click. A single drawing cannot uniquely specify depth: accuracy follows the
reconstructed collider (or the approximate splat fallback), and the model's proportions
determine its silhouette. The size, turn and upright controls remain available.

Performance: fixed 1× display resolution, a 500k visible splat LOD budget, 3D rendering
paused while drawing, and capped snapshot dimensions. Generation time varies with
provider load; an earlier three-colour object completed in about 71 seconds.

Validation: `npm test` covers surface anchoring, captured-camera fitting, the generation
API, GLB colour preservation and STL conversion; `npm run build` type-checks and builds
the app.

Color preservation: new jobs generate standard image-aligned textures and retain the finished GLB unchanged. Scene models and the root viewer preview use the original embedded materials. The model library also exposes GLB downloads after reload. STL remains a separate no-color print derivative. Existing gray objects remain gray. Research and implementation notes: [COLOR_PIPELINE.md](COLOR_PIPELINE.md).
