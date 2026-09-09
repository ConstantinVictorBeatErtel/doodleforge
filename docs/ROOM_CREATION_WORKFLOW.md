# Room creation from images and video

## Current decision

The user subsequently supplied three rear-stage photos (`IMG_6891`–`IMG_6893`) and authorized updating the room if adequate. They were accepted and cleaned, including human reflections in the screen. An eight-image reconstruction is recorded in [STAGE_REAR_UPDATE.md](STAGE_REAR_UPDATE.md); it adds rear photographic coverage while preserving the previous world as a separate version. Combined inputs and both sets of cleanup prompts/hashes live under `data/captures-stage-complete/` and are included in the updated release.

Earlier stage capture, September 5, 2026: the user supplied a new 25.19-second stage-view video and five photos (IMG_6885–IMG_6890) and explicitly requested proceeding if the assets were suitable. Inspection accepted the set and supersedes the earlier generation hold. Five cleaned stills were created with built-in imagegen and submitted in multi-image reconstruction mode. The new **demo-stage** world `82f39764-5224-4574-8328-8a747f42ed3e` completed successfully; no people are visible in its panorama/thumbnail. See [stage capture and generation record](STAGE_WORLD_RESULT.md).

The original room `b7fc3a55-8fc1-4ef0-8ac8-705c3abe7d5a` remains available and contains people. Its files are preserved separately from the stage version.

## Where to record

The user has now chosen the demo stage as the capture viewpoint. Future refinements should use that same position and face toward the room's dark far alcove and yellow pendant light. Keep the stage edge, floor, tables, and columns visible. The earlier aisle/table guidance applies only if deliberately choosing a different scene origin; do not move the capture to the center for this stage version.

Hold the phone level at chest/eye height, preferably landscape. Keep the same lens, zoom, exposure, and focus throughout. Rotate slowly in place through 180–360 degrees during one continuous 20–30 second shot, with no cuts. Include the floor and table surfaces as well as the ceiling. Wait for the immediate area to be empty if possible. A clean partial sweep is more useful than a fast, blurred full rotation.

For photos, take 4–8 sharp overlapping views from approximately that same position. Use the same dimensions and orientation. Preserve recognizable overlap such as table corners, columns, and windows. Keep additional close-ups of the placement surface as references; do not automatically mix a distant close-up into the reconstruction set.

Measure one recognizable span in millimeters for scale calibration and a different nearby span for verification. Capture advice follows [World Labs video guidance](https://docs.worldlabs.ai/marble/create/prompt-guides/video-prompt) and [multi-image guidance](https://docs.worldlabs.ai/marble/create/prompt-guides/multi-image-prompt); choosing the demo table's viewpoint is our project-specific recommendation.

## Implemented pipeline

1. Preserve the original input. Make prepared JPEG copies of HEIC photos with orientation baked and metadata omitted. Make upright SDR H.264 MP4 copies of iPhone HDR videos, with audio and metadata removed.
2. Validate decoded image sizes and video duration/file size. Reconstruction uses 2–8 same-size images; video uses one continuous clip of at most 30 seconds/100 MB.
3. Record file names and SHA-256 hashes. Choose one input mode: single image, multi-image reconstruction, or video.
4. Prepare a signed upload through `POST /marble/v1/media-assets:prepare_upload`. Upload each prepared file with the returned method and headers. Keep the World Labs key on the API host only.
5. Build the world request. For multiple photos, set `world_prompt.type: multi-image` and `reconstruct_images: true`; provide the uploaded media references without inventing azimuth angles. Set `model: marble-1.1-plus` explicitly.
6. After the user resumes generation, check API credits, save submission intent, and submit `POST /marble/v1/worlds:generate` once. Save its operation ID before polling. Do not automatically repeat a paid submission after an uncertain timeout.
7. Poll the saved operation, fetch the completed world, and download every returned SPZ resolution, collider GLB, panorama, and thumbnail. Save the exact provider response locally.
8. Write the portable manifest with relative file paths, hashes, model, world ID, scale metadata, and separate splat/collider transform status. Validate file integrity and inspect output quality.
9. In the viewer, verify collider alignment and independently measured scale before using the scene to claim physical fit.

The code lives in `scripts/prepare_capture.py`, `scripts/world.mjs`, `scripts/worldlabs.mjs`, and `scripts/verify_world.py`. The existing run's observations are in [FIRST_WORLD_RESULT.md](FIRST_WORLD_RESULT.md).

## Reproducing from photos without starting generation

Install the media dependencies described in the root README, then prepare new inputs:

```sh
python3 scripts/prepare_capture.py /path/to/front.HEIC /path/to/right.HEIC /path/to/back.HEIC /path/to/left.HEIC
```

Preview the request locally:

```sh
npm run world -- generate \
  --input data/captures/prepared/front.jpg \
  --input data/captures/prepared/right.jpg \
  --input data/captures/prepared/back.jpg \
  --input data/captures/prepared/left.jpg \
  --job room-without-people-01 \
  --model marble-1.1-plus \
  --prompt "An unoccupied version of the same room. Preserve the architecture, windows, columns, lighting, furniture positions, table edges, and floor layout. No people or human silhouettes." \
  --dry-run
```

`--dry-run` performs local validation only. A text request for an unoccupied room is guidance, **not a reliable people-removal step**. The stage run used visually reviewed, edited photos before generation. Later generations are stochastic and are not guaranteed to reproduce identical geometry from the same files.

## People removal

Best input: a clean capture in which the important table/floor surfaces are actually visible. Existing captures are sufficient for a visual cleanup attempt, but covered surfaces must be inferred when no reference reveals them.

For the existing room, the preferred refinement experiment is to edit its panorama first, inspect that result, and only then create a new world. World Labs documents selected-area changes and a panorama preview before the final Create world action in [Pano Edit](https://docs.worldlabs.ai/marble/edit/pano-edit). A draft edit request is:

> Remove every person, human silhouette, and reflection of a person. Preserve the existing architecture, windows, columns, ceiling beams, lighting, tables, chairs, laptops, and other stationary objects. Fill only the areas exposed by removal, using visible adjacent surfaces and reference images. Preserve the panorama projection, framing, and dimensions. Do not redesign the room or add new furniture.

Review for remaining faces/limbs, floating bags/clothing, broken chair legs, altered table edges, and inconsistent floors. Keep original and cleaned inputs separately, with edit prompt, hashes, provider/model, and review notes. Mark filled occluded areas as inferred. A cleaned image is not proof that the underlying room geometry is correct.

For a fresh multi-image set, any edits must remain consistent across overlapping views. Review all views together before submitting them. Independent edits can disagree about hidden furniture; clean capture is preferable when possible.

The stage capture's cleanup was run as five built-in imagegen photo edits, one target photo per call with the other four originals as references. All outputs were inspected; no people were visible, but some desktop clutter was also simplified. Exact prompts, source/output hashes, and limitations are stored in `data/captures-stage/cleanup-generation.json` and included in the stage archive. Cleanup is currently an agent-orchestrated step, not an automated CLI feature. The current CLI treats single images as non-panoramas, so a cleaned 360-degree panorama must use Marble's supported editing workflow or a future explicitly implemented panorama input mode. Do not pass it to the current ordinary-photo command.

## Download and provenance

The [first room release](https://github.com/ConstantinVictorBeatErtel/doodleforge/releases/tag/room-capture-2026-09-05) contains all generated binary assets, a portable manifest, validation results, generation provenance, and a separate archive of all 13 prepared source captures. The current release still contains people.

`scripts/package_room.py` packages the files without API credentials, temporary signed provider URLs, audio, or original device metadata. The original HEIC/MOV files remain local and untouched. Asset SHA-256 checksums permit verification after download. This repository and its release downloads are public; the original Marble world itself keeps its existing account permissions.
