# High-quality mesh, cleanup and scale verification

The user authorized high-quality mesh export and geometry cleanup for the completed eight-view stage room, followed by scale verification. World: `262dd7ba-d156-46a1-8445-f62bc60e1265`.

## Export

Marble billing showed a promotional Pro plan with 40,000 credits. The high-quality mesh dialog quoted 3,500 Marble credits; generation was started once around September 5, 2026, 20:29:45 UTC and confirmed by the disabled “Preparing high-quality mesh” export entry. The refreshed balance was 36,500 credits, confirming the 3,500-credit charge. No subscription or additional credit purchase was made. Marble API credits are separate.

Generation completed and both full GLB variants were retrieved. The UI settings were OpenGL, ground level, textured / vertex-colored. However, the browser did not deliver its transformed export file. We downloaded the actual GLB URLs observed in the export request instead. **These CDN source files are raw OpenCV-like coordinates**, before the browser export transform. Sources and job provenance are in `job.json` in the release.

`provider-frame.json` records the original room manifest transform: uniform scale 2.470399856567383, flip Y and Z, then translate Y by 1.702193021774292. The textured provider-frame derivative was visually checked upright and aligned with the hall. Its measured width then required an additional uniform correction of 0.884329024925641. The final `*-nominal-meters.glb` files already include both coordinate conversion and nominal scale; **do not apply either transform again**. Camera positions, splats, colliders and anchors must use the same frame when integrating these meshes with the app.

## Completed results and downloads

[Download all full mesh files and reports](https://github.com/ConstantinVictorBeatErtel/doodleforge/releases/tag/stage-hq-mesh-2026-09-05). Large binaries are GitHub Release assets, while tools and this guide are tracked in Git. The existing app still uses its saved splat and collider; this mesh release does not silently replace them.

| Variant | Source triangles | Cleaned triangles | Removed | Intended use |
| --- | ---: | ---: | --- | --- |
| Textured | 591,463 | 591,432 | 31 zero-area faces | Convenient textured inspection and editing |
| Vertex-colored | 16,172,984 | 16,172,762 | 219 zero-area and 3 duplicate faces | Densest geometry supplied by this HQ export |

The dense source has 8,091,112 vertices. Original binary geometry/color/texture data was retained in cleanup and in the scaled derivatives. The dense mesh has 1,922 boundary edges, 24 non-manifold edges, consistent winding and 14,019 connected vertex components after exact-position welding for analysis. The textured mesh has 11,676 boundary edges, 10,660 non-manifold edges, inconsistent winding and 897 components. Neither is watertight; self-intersections were not checked. Small disconnected parts may include furniture details as well as artifacts, so no blanket deletion was applied.

**Judgment:** suitable for a room demo and a detailed editing source. Chairs, tables and occluded surfaces still show generated distortions and gaps. More triangles improve representation of the generated surface; they do not recover survey-grade truth. A print requires a separate selected-object or room-shell repair pass, solidification, hole closure and slicer validation.

The measured lower central left window calibrates to 130.72 cm width. Its checked height becomes **78.98 cm**, compared with the nominal **81.70 cm** reference: **2.72 cm / 3.32% error**, passing the demo threshold of 4.085 cm / 5%. This is approximate agreement only, because phone case length and counting error are unknown. A single uniform correction was used, with no axis stretching. The same transform was transferred to the co-registered dense variant; its window was not independently repicked.

Release archives contain unchanged sources, cleaned derivatives, nominal-meter derivatives, SHA-256 checksums, audits, exact picked coordinates and transforms. The textured archive also contains the intermediate provider-frame GLB. `measurements.json` records the inspector camera, viewport and pixel picks so the endpoint selection can be reproduced.

For local viewing after extracting into `data/worlds/hackathon-stage-complete-02/hq-mesh/`, run the inspector below and open `http://127.0.0.1:8766/?file=textured-nominal-meters.glb`. Choose `vertex-colored-nominal-meters.glb` for the dense version; its 16 million triangles and large download require more memory. Opening the HTML directly using `file://` will not load the mesh dependencies.

## Cleanup policy

`scripts/clean_room_mesh.py` writes a new GLB and an audit JSON. It removes only zero-area triangles and exact duplicate oriented triangles. All original embedded vertex attributes, normals, UVs, image payloads, materials and scene transforms are retained; triangle indices are appended to the existing binary buffer. Reversed faces are preserved because they may intentionally represent opposite sides of a surface. No texture recompression, smoothing or decimation is applied.

The audit welds exactly coincident positions in an analysis copy to avoid confusing UV seams with holes. It reports boundary edges, non-manifold edges, connected vertex components, winding consistency, watertightness and bounds. Open room surfaces are not automatically capped, and disconnected furniture is not automatically discarded. Self-intersections and print readiness require additional inspection; passing this cleanup does not certify a watertight printable object.

Setup and usage:

```sh
python3 -m venv data/mesh-tools-venv
data/mesh-tools-venv/bin/python -m pip install -r requirements-mesh.txt
data/mesh-tools-venv/bin/python scripts/clean_room_mesh.py source.glb cleaned.glb
```

## Physical reference supplied by the user

The user measured the outer edges of the **lower section of the central window on the left wall** (viewed from the stage into the hall). Each wall has three windows, reported to be the same size. The measured section is eight iPhone 17 Pro Max lengths across and five lengths vertically. The phone had a slight case.

[Apple specifies the phone body length as 163.4 mm / 6.43 inches](https://www.apple.com/iphone-17-pro/specs/). Using the exact millimeter value:

| Span | Phone lengths | Nominal centimeters | Nominal inches |
| --- | ---: | ---: | ---: |
| Lower-section outer width | 8 | 130.72 | 51.46 |
| Lower-section outer height | 5 | 81.70 | 32.17 |
| Two equal section heights, excluding divider/gap | 10 | 163.40 | 64.33 |

The case adds an unknown amount to each phone length. Count placement adds further uncertainty. These nominal dimensions therefore support approximate scale calibration, not a precise room survey. The doubled height is derived, not an independently measured total window height.

## Picking and verification

Install the viewer dependency locally if the root project has not installed it:

```sh
npm install --prefix data/mesh-preview-deps three@0.180.0
python3 scripts/inspect_room_mesh.py data/worlds/hackathon-stage-complete-02/hq-mesh
```

Open the printed localhost URL. The server binds only to 127.0.0.1 and serves the inspector, GLBs in the selected directory, and Three.js modules. Pick the lower window section's top-left, top-right and bottom-left outer frame corners. Record the mesh SHA-256, exact scene coordinates, feature identification and visual evidence. Width calibrates; height independently checks local proportions. Both spans share the phone/case systematic uncertainty.

`scripts/verify_room_scale.py measurements.json cleaned.glb --out scale-verification.json` verifies the input hash and computes a uniform scale to nominal meters from the first span. It checks the second span against `max(20 mm, 5% of measured span)`, the project's demo target. It rejects reused or coincident endpoints and does not claim certified metric accuracy. Apply the reported column-major transform exactly once to the room and its camera/anchors. Never stretch axes separately just to make both measurements pass: that would conceal reconstruction distortion.

Use `--scaled-mesh nominally-scaled.glb` to create a derivative with one uniform transform on the scene roots. It preserves the original binary geometry and texture chunks; a reserved node label may be renamed for importer compatibility. The raw exports must remain available. Store any scaled derivative under a separate filename and record its source hash and transform. Matching the window does not prove that every generated desk or hidden surface has accurate dimensions.
