# Room from the demo stage

Capture accepted September 5, 2026. The user requested the new world from the demo-stage perspective and authorized proceeding if the new assets were adequate, superseding the earlier generation hold.

## Capture judgment

- `IMG_6885.MOV`: 25.19 seconds, continuous left-to-right sweep from the stage. The slower sweep and visible stage edge/floor make it a better basis for this viewpoint than the first capture.
- `IMG_6886.HEIC`: main view looking from the stage toward the dark far alcove and yellow pendant lamp.
- `IMG_6889.HEIC`, `IMG_6890.HEIC`: overlapping leftward views, including windows, columns, a plant, and part of the green stage seating.
- `IMG_6888.HEIC`, `IMG_6887.HEIC`: overlapping rightward views, including columns, windows, stage edge, and green seating.

The set is good enough for a visual reconstruction. Many people obscure furniture, and the view behind the camera is not fully captured. No additional footage is required for this attempt; a physically accurate view of hidden surfaces cannot be recovered from these inputs alone.

## People removal performed

All five HEICs were converted to upright JPEGs at 1536×2048. Five separate **built-in imagegen** edits removed people, using the other four photos as supporting references for each target. Source copies are untouched. Outputs are five 1086×1448 PNGs under `data/captures-stage/cleaned/`.

All five edited images were visually reviewed: no people are visible. Main architectural landmarks and the stage/floor relationship remain recognizable. Some table surfaces, chair details, laptops, and small desktop items were reconstructed or simplified beyond the occupied areas; the clean views are suitable for a visual demo, not an exact inventory or measured room survey.

The full prompt and per-image input/output hashes are in `data/captures-stage/cleanup-generation.json`. Its edit specification is: remove every person and reflection; preserve the target photograph's exact stage viewpoint, portrait framing, columns, windows, ceiling structure, stage edge, plants, furniture positions, and visible equipment; fill the areas exposed by removal using reference views. The result was then checked for remaining people and obvious layout changes.

## World request

- Job: `hackathon-stage-no-people-01`
- Model: `marble-1.1-plus`
- Input mode: `multi-image`, `reconstruct_images: true`
- Input order: cleaned `6886`, `6889`, `6890`, `6888`, `6887`
- Main stage reference: `IMG_6886-no-people.png`
- Text guidance: preserve the stage capture origin, face the dark far alcove and yellow pendant lamp, reconstruct the same room, and include no people or human silhouettes.
- Video: prepared and retained as reference, not submitted alongside the cleaned images.
- Starting API balance: 5,400 credits. Estimated generation range: 1,600–3,100 credits.

The stage viewpoint is a generation constraint and reference, not a measured camera pose. A viewer's exact starting camera position/orientation must be validated against the generated scene. Do not silently reuse the first world's camera calibration.

## Completed result

- [Open the new world](https://marble.worldlabs.ai/world/82f39764-5224-4574-8328-8a747f42ed3e) in the owning World Labs account.
- World ID: `82f39764-5224-4574-8328-8a747f42ed3e`
- Operation ID: `a388adc8-69e2-47cd-a03e-14d04e43e474`
- Start: September 5, 2026, 19:20:14 UTC; saved: 19:26:37 UTC (about 6 minutes 23 seconds including uploads/downloads).
- API balance: 5,400 → 3,800 credits; observed decrease 1,600 credits ($1.28 at standard World Labs pricing). Built-in imagegen usage is separate from that API balance.
- Local manifest: `data/worlds/hackathon-stage-no-people-01/manifest.json`
- [Download full assets, prepared sources, cleaned photos, and provenance](https://github.com/ConstantinVictorBeatErtel/doodleforge/releases/tag/stage-room-2026-09-05).

All seven downloaded assets passed file-integrity checks: 98,304 / 150,000 / 500,000 / 1,920,000-point SPZ files, one collider GLB with 112,794 vertices, a 4608×2304 panorama PNG, and a 720×480 thumbnail WebP. SPZ gzip streams passed CRC validation; GLB structure and image decoding passed.

Visual inspection of the panorama and thumbnail shows **no visible people**. The carpeted stage occupies the foreground and the dark far alcove/yellow pendant appears ahead, consistent with the requested stage viewpoint. The model changed the shape and number of green stage chairs in generated areas and altered some furniture/desktop details. The uncaptured area behind the camera remains inferred. This is suitable for the next visual demo stage, not a measured digital twin.

No additional capture is needed before viewer integration. Browser navigation, the exact starting camera pose, collider/splat alignment, and metric accuracy still need verification. The new manifest records the stage reference and forward landmark; do not reuse the first room's calibration or camera settings without checking them.
