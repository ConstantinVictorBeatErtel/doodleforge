# Stage room with the missing rear view

On September 5, 2026 the user supplied `IMG_6891.HEIC`, `IMG_6892.HEIC`, and `IMG_6893.HEIC`, asking for an update if the photos were adequate. All three were accepted: they are sharp enough for the demo, overlap around the screen/plants, and show the missing rear wall and adjoining sides from the stage. No retake was required.

## Capture and cleanup

- `6891`: rear-left while facing the screen; window, speaker, plant, stage chair, screen edge.
- `6892`: straight rear; large black screen, white equipment cabinet, exit door/sign, flanking plants and speakers.
- `6893`: rear-right while facing the screen; plant, speaker, stage chair, side windows and seating.

People at the edges and the photographer's reflection in the television were removed with three built-in imagegen edits. Each call used one target and the other two originals as reference. All three outputs were visually inspected: no people or human reflections remain visible. The edits also simplified some floor clutter and furniture hidden by people, so these are visual reconstruction inputs, not a measured survey.

The previous five cleaned stage images were reused unchanged. All eight inputs are 1086×1448 PNGs. Original files remain untouched. Prepared originals, cleaned images, exact front/rear cleanup prompts, source/output SHA-256 hashes, and review notes are collected in `data/captures-stage-complete/cleanup-generation.json` and its sibling `prepared/` and `cleaned/` folders.

## Updating the world

This update uses a new multi-image reconstruction through the [generation API](https://docs.worldlabs.ai/api/reference/worlds/generate), preserving the previous world as a comparison. It is not an in-place geometry patch. The model can change the front and sides as well as the newly documented rear.

- Job: `hackathon-stage-complete-02`
- Model: `marble-1.1-plus`
- Mode: `multi-image`, `reconstruct_images: true`
- Order: cleaned `6886`, `6889`, `6890`, `6888`, `6887`, `6891`, `6892`, `6893`
- Forward reference: `6886`, looking toward the dark far alcove/yellow pendant.
- Rear reference: `6892`, screen/cabinet and exit behind the starting camera.
- Prompt: reconstruct one connected hall from the eight photographs, preserve stage origin and architecture, place the screen opposite the far alcove, retain furniture, exclude people and human reflections.
- Exact generation prompt and request are saved in the local job and portable release provenance.
- Previous world: `82f39764-5224-4574-8328-8a747f42ed3e`.

The camera origin and direction are reference constraints, not a verified metric pose. Viewer camera settings and collider alignment must be checked for this version separately.

## Completed result

- [Open the updated room](https://marble.worldlabs.ai/world/262dd7ba-d156-46a1-8445-f62bc60e1265) while signed into the owning World Labs account.
- World ID: `262dd7ba-d156-46a1-8445-f62bc60e1265`
- Operation: `8a38eabe-c4ad-4319-8f10-592a02789fa5`
- Started: 2026-09-05 19:44:01 UTC; saved: 19:59:23 UTC (15 minutes 22 seconds including transfer).
- API balance: 3,800 → 2,200 credits; observed decrease 1,600 credits. Built-in imagegen usage is separate.
- [Full room, all prepared stage captures, eight cleaned photos and exact prompts/hashes](https://github.com/ConstantinVictorBeatErtel/doodleforge/releases/tag/stage-rear-2026-09-05).
- Local manifest: `data/worlds/hackathon-stage-complete-02/manifest.json`.

Visual panorama review: the missing rear now contains the black screen, white cabinet, exit sign and flanking plants. The screen lies across the left/right edge of the flat 360° panorama, which represents the rear seam. The stage foreground and forward dark alcove/yellow lamp remain recognizable. No people or human screen reflections are visible in this review. This improves the visual completeness over the previous panorama, which repeated room features into the unseen rear.

Furniture still changes: the generated green stage chairs have arms, side tables become round, and the cabinet/plant details differ. Hidden surfaces remain inferred. This is suitable for a visual demo, not proof of measured room accuracy or a verified navigable rear surface. The browser camera, splat/collider alignment and scale remain unverified.

All seven assets passed checksums and structural checks: four SPZ files (97,470 / 150,000 / 500,000 / 2,400,000 points), a GLB collider with 102,429 vertices, a 4608×2304 panorama and 720×480 thumbnail. Gzip CRCs passed, GLB geometry was nonempty, and images decoded successfully. The previous worlds and releases remain available.
