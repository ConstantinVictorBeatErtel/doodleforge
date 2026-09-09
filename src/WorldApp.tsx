// The room: walk it, sketch objects into it, place them on real surfaces, share it.
//
// This is the standalone first-person editor rewired onto Convex. What changed from
// the local version: the room geometry, the object library and the placements all come
// from Convex instead of `public/` and IndexedDB, generation is a scheduled Convex
// action instead of a local job server, and other players can be in here with you.
//
// What deliberately did not change is the placement maths — `surfacePick` raycasts the
// Marble collider, reads the real triangle normal, and `orientTo` stands the object on
// it. That is the part that makes objects land on tables instead of floating.
import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { Asset, disposeModel, gltfLoader } from "./components/Asset";
import { PlacementGhost, type GhostState } from "./components/PlacementGhost";
import { Collider, SparkSetup, SplatWorld } from "./components/SplatWorld";
import { Walk, type MouseLook, type TouchInput } from "./components/LocalWalk";
import { TouchControls } from "./components/TouchControls";
import { Players } from "./components/Players";
import { DebugPanel, DEBUG_DEFAULTS, type DebugSettings } from "./components/DebugPanel";
import { DrawingBridge, DrawingLayer, type DrawingCapture, type DrawingRequest } from "./components/DrawingLayer";
import { SketchGhost } from "./components/SketchGhost";
import { SketchSolver, type SketchSolverApi } from "./components/SketchSolver";
import { type DrawingAnchor } from "./lib/drawingPlacement";
import { resolveSketchPose, type Facing, type PoseTools } from "./lib/sketchPose";
import { pickSurface } from "./lib/surfacePick";
import { usePlacementHistory, type PlacementInput } from "./lib/placementHistory";
import { ConvexProjectClient } from "./lib/ConvexProjectClient";
import { ExistingWorlds } from "./components/ExistingWorlds";
import { getSessionId, randomColor } from "./lib/session";
import { glbToStl, downloadBlob, safeFilename, PRINT_HEIGHT_MM } from "./lib/stlExport";

// Never invent a ground plane: an object may only land on the reconstructed collider
// or on a real splat hit, so a miss places nothing rather than guessing a depth.
const SURFACES = { collider: true, splat: true, plane: false };
// Plural: several sketches can be in flight (drawn, uploading, generating) at once, each
// tracked independently so one job's reload recovery never clobbers another's.
const JOBS_KEY = "galatea-sketch-jobs-v1";
// Above this the stroke cutout is dropped from localStorage rather than risking the quota.
const STROKE_BUDGET = 1_500_000;
const STAGES = [
  ["image", "Image"],
  ["cutout", "Cutout"],
  ["mesh", "3D + color"],
  ["done", "Ready"],
] as const;

type Armed = { assetId: Id<"assets">; url: string; movingId?: Id<"placements">; targetSize: number };
type PlacementDoc = {
  _id: Id<"placements">;
  assetId: Id<"assets">;
  position: number[];
  rotation: number[];
  scale: number;
  targetSize?: number;
  glbUrl: string | null;
};
type AssetDoc = Doc<"assets"> & { glbUrl: string | null; cutoutUrl: string | null };
// One sketch, from submission through to a placed (or placeable) object. Kept with its
// anchor so a reload can still turn a finished mesh into a size estimate without resubmitting.
type JobEntry = { assetId: Id<"assets">; anchor: DrawingAnchor; startedAt: number; strokeImage?: string };
type History = ReturnType<typeof usePlacementHistory>;
type PlaceFn = (args: PlacementInput & { room: string }) => Promise<Id<"placements">>;

function loadJobs(): JobEntry[] {
  try {
    const saved = JSON.parse(localStorage.getItem(JOBS_KEY) || "null");
    if (!Array.isArray(saved)) return [];
    return saved.filter((j): j is JobEntry =>
      Boolean(j?.assetId) && j.anchor?.cameraWorld?.length === 16 && j.anchor?.projection?.length === 16 && Array.isArray(j.anchor?.strokes));
  } catch { return []; }
}

class ColliderBoundary extends Component<{ children: ReactNode; onError: (message: string) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError(`Room collider unavailable; using splat surfaces. ${error.message}`); }
  render() { return this.state.failed ? null : this.props.children; }
}

export default function WorldApp({ initialWorldId, onNewWorld }: { initialWorldId?: string; onNewWorld: () => void }) {
  const convex = useConvex();
  const projectClient = useMemo(() => new ConvexProjectClient(convex), [convex]);
  const sessionId = useMemo(getSessionId, []);
  const explicitRoom = useMemo(() => new URLSearchParams(location.search).get("room"), []);
  // ?debug=1 opens the transform sliders and draws the collider as a wireframe. Worth
  // a look before trusting a placement: splat and collider alignment is not verified.
  const debug = useMemo(() => {
    const q = new URLSearchParams(location.search);
    return q.has("debug") || q.has("debugCollider");
  }, []);
  // ?vision=1 asks a hosted vision model which way round a finished sketch faces. Off by
  // default: it costs two uploads and a round trip per object, and the geometric sweep it
  // assists is already the answer whenever the generated mesh resembles what was drawn.
  const vision = useMemo(() => new URLSearchParams(location.search).has("vision"), []);

  const worlds = useQuery(api.worlds.list) ?? [];
  const [activeWorld, setActiveWorld] = useState<string | null>(initialWorldId ?? null);
  const world = activeWorld ? worlds.find((w) => w._id === activeWorld) : worlds.find((w) => w.status === "ready");
  const room = explicitRoom ?? activeWorld ?? world?._id ?? "lobby";

  const assets = useQuery(api.assets.list) ?? [];
  const placementsResult = useQuery(api.assets.placementsInRoom, { room });
  const placements = useMemo(() => placementsResult ?? [], [placementsResult]);
  const place = useMutation(api.assets.place);
  const removePlacement = useMutation(api.assets.removePlacement);
  const updatePlacement = useMutation(api.assets.updatePlacement);
  const clearRoom = useMutation(api.assets.clearRoom);
  const startSketch = useMutation(api.assets.startSketch);
  const resumeSketch = useMutation(api.assets.resumeSketch);
  const uploadUrl = useMutation(api.worlds.generateUploadUrl);
  const join = useMutation(api.players.join);
  const resumeWorld = useMutation(api.worlds.resumeGeneration);
  const genWorld = useAction(api.worlds.generateFromText);
  const orient = useAction(api.orientation.orientSketch);

  const history = usePlacementHistory(room, { place, remove: removePlacement, update: updatePlacement });

  const [paused, setPaused] = useState(false);
  const [mouseLocked, setMouseLocked] = useState(false);
  const mouseLookRef = useRef<MouseLook | null>(null);
  // Pointer Lock never works on iOS (WebKit doesn't implement it on touch-first devices, in
  // Safari or any WKWebView wrapper), so touch devices get a joystick + drag-to-look overlay
  // instead. Computed once — this doesn't change over the life of a tab.
  const [isTouch] = useState(() => typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)")?.matches ?? false));
  const touchInputRef = useRef<TouchInput>({ moveX: 0, moveZ: 0, lookDX: 0, lookDY: 0, flyY: 0, pinchDelta: 0 });
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [drawing, setDrawing] = useState<DrawingCapture | null>(null);
  const captureRef = useRef<(() => DrawingCapture) | null>(null);
  const [roomReady, setRoomReady] = useState(false);
  const [selected, setSelected] = useState<Id<"placements"> | null>(null);
  const [armed, setArmed] = useState<Armed | null>(null);
  const [ghost, setGhost] = useState<GhostState>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [reset, setReset] = useState(0);
  const [yaw, setYaw] = useState(0);
  // Set when something asked for first-person control back; the request itself has to wait
  // for the next render (see the effect below).
  const [wantLook, setWantLook] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [error, setError] = useState("");
  const [joined, setJoined] = useState(false);
  const [zipStatus, setZipStatus] = useState("");
  const [worldPrompt, setWorldPrompt] = useState("a cozy candle-lit library with tall shelves");
  const [cfg, setCfg] = useState<DebugSettings>(DEBUG_DEFAULTS);
  const [submitting, setSubmitting] = useState(false);
  const [generatingWorld, setGeneratingWorld] = useState(false);
  const submissionBusy = useRef(false);
  const worldBusy = useRef(false);
  const [exporting, setExporting] = useState(false);
  const zipInput = useRef<HTMLInputElement>(null);

  // The sketches we are watching, oldest first. Several can be drawn, uploading or generating
  // at once — drawing another does not wait on a previous one to finish.
  const [jobs, setJobs] = useState<JobEntry[]>(loadJobs);
  const solveRef = useRef<SketchSolverApi | null>(null);
  // Whether each job's yaw sweep found a clear winner, so its card can say why it faces you.
  const [facingByAsset, setFacingByAsset] = useState<Record<string, Facing>>({});
  // Ticks once a second while any job is generating, so each card's elapsed time stays live.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    try {
      localStorage.setItem(JOBS_KEY, JSON.stringify(jobs.map((j) =>
        j.strokeImage && j.strokeImage.length > STROKE_BUDGET ? { ...j, strokeImage: undefined } : j)));
    } catch { /* quota: jobs still work in-memory this session */ }
  }, [jobs]);

  useEffect(() => {
    const anyGenerating = jobs.some((j) => assets.find((a) => a._id === j.assetId)?.status === "generating");
    if (!anyGenerating) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [jobs, assets]);

  const active = placements.find((p) => p._id === selected);
  const readyAssets = assets.filter((a) => a.status === "ready" && a.glbUrl);
  const metricScale = (world?.metricScale ?? 1) * (debug ? cfg.metricScaleMul : 1);
  const groundOffset = (world?.groundOffset ?? 0) + (debug ? cfg.groundOffsetAdd : 0);

  const onSplatReady = useCallback(() => { setRoomReady(true); setError(""); }, []);
  const onSplatError = useCallback((message: string) => setError(`Could not load the room: ${message}`), []);

  const cancel = useCallback(() => { setArmed(null); setGhost(null); }, []);

  const arm = useCallback((assetId: Id<"assets">, url: string, movingId?: Id<"placements">, suggestedSize?: number) => {
    const existing = placements.find((p) => p._id === movingId);
    mouseLookRef.current?.release();
    setPaused(true); setLibraryOpen(true); setSelected(null);
    setArmed({
      assetId, url, movingId,
      targetSize: existing ? (existing.targetSize ?? 0.5) * existing.scale : suggestedSize ?? 0.5,
    });
    setYaw(0); setGhost(null); setPreviewReady(false); setError("");
  }, [placements]);

  /** Clicking an object in the room drops straight into the placement UI, with its own pose. */
  const editPlacement = useCallback((p: PlacementDoc) => {
    if (p.glbUrl) arm(p.assetId, p.glbUrl, p._id);
  }, [arm]);

  // --- the sketch jobs -------------------------------------------------------
  // A finished mesh goes straight into the room, where the drawing said it should be — see
  // JobWatcher below, one instance per job, so several sketches can generate and land at once
  // without one job's completion effect racing another's.
  const onJobPlaced = useCallback((assetId: Id<"assets">, placementId: Id<"placements">, facing: Facing) => {
    setSelected(placementId);
    setFacingByAsset((prev) => ({ ...prev, [assetId]: facing }));
  }, []);

  const dismissJob = (assetId: Id<"assets">) => {
    setJobs((prev) => prev.filter((j) => j.assetId !== assetId));
    setFacingByAsset((prev) => { if (!(assetId in prev)) return prev; const next = { ...prev }; delete next[assetId]; return next; });
  };

  // Hoisted out of submitDrawing: JobWatcher uploads the contact sheet through this too.
  const store = useCallback(async (dataUrl: string) => {
    const blob = await (await fetch(dataUrl)).blob();
    const url = await uploadUrl();
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "image/png" }, body: blob });
    if (!response.ok) throw new Error(`Upload failed (HTTP ${response.status}).`);
    return (await response.json()).storageId as Id<"_storage">;
  }, [uploadUrl]);

  async function submitDrawing(request: DrawingRequest) {
    if (submissionBusy.current) return;
    submissionBusy.current = true;
    setSubmitting(true); setError("");
    try {
      const [imageStorageId, cleanStorageId] = await Promise.all([store(request.image), store(request.cleanImage)]);
      const assetId = await startSketch({ imageStorageId, cleanStorageId, description: request.description });
      const next: JobEntry = { assetId, anchor: request.anchor, startedAt: Date.now(), strokeImage: request.strokeImage };
      setNow(next.startedAt);
      // Appended, not replacing: an earlier job may still be generating, and it keeps watching
      // itself (see JobWatcher) regardless of what else gets drawn next.
      setJobs((prev) => [...prev, next]);
      setDrawing(null); resumeWalking();
    } catch (e) {
      setError(`Could not start generation: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      submissionBusy.current = false;
      setSubmitting(false);
    }
  }

  async function downloadStl(url: string, name: string) {
    setExporting(true); setError("");
    try { downloadBlob(await glbToStl(url), `${safeFilename(name)}-${PRINT_HEIGHT_MM}mm.stl`); }
    catch (e) { setError(`STL export failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setExporting(false); }
  }

  // --- room controls --------------------------------------------------------
  const resumeWalking = useCallback(() => { setError(""); setPaused(false); setWantLook(true); }, []);

  // Pointer lock can only be requested once <Walk> has re-rendered with enabled={!drawing};
  // asking in the same tick as setDrawing(null) is silently refused. The H keydown's transient
  // activation still covers the request one effect later.
  useEffect(() => {
    if (drawing || !wantLook) return;
    setWantLook(false);
    // A slow upload can outlast the click that started it. Asking anyway would only earn a
    // "mouse capture was unavailable" toast; leave the cursor free and let a click re-lock.
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    mouseLookRef.current?.capture();
  }, [drawing, wantLook]);

  const beginDrawing = useCallback(() => {
    if (!captureRef.current) return;
    cancel(); setPaused(true); setError("");
    try { setDrawing(captureRef.current()); }
    catch (e) { setError(`Could not capture the room: ${String(e)}`); }
  }, [cancel]);

  const leaveDrawing = useCallback(() => { setDrawing(null); resumeWalking(); }, [resumeWalking]);

  const selectWorld = (id: string) => {
    setActiveWorld(id); setJoined(false); setError("");
    if (world?._id !== id) setRoomReady(false);
    cancel(); setSelected(null); history.clear();
    const url = new URL(location.href);
    url.searchParams.set("world", id);
    url.searchParams.delete("job");
    history_replace(url);
  };

  // A world .zip is unpacked in the browser and pushed into Convex storage: the same
  // end state as a Marble generation, with no API key and no waiting.
  async function uploadWorldZip(file: File) {
    setZipStatus(`reading ${file.name}…`);
    try {
      selectWorld(await projectClient.importZip(file));
      setZipStatus(`loaded ${file.name}`);
    } catch (e) {
      setZipStatus(`failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function generateWorld() {
    if (worldBusy.current || !worldPrompt.trim()) return;
    worldBusy.current = true;
    setGeneratingWorld(true); setError("");
    try {
      selectWorld(await genWorld({ prompt: worldPrompt }));
    } catch (e) {
      setError(`Could not create the world: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      worldBusy.current = false;
      setGeneratingWorld(false);
    }
  }

  const asInput = (p: PlacementDoc): PlacementInput =>
    ({ assetId: p.assetId, position: p.position, rotation: p.rotation, scale: p.scale, targetSize: p.targetSize });

  const editActive = async (patch: Partial<PlacementInput>) => {
    if (!active) return;
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, (active as any)[k]]));
    await updatePlacement({ id: active._id, ...patch });
    history.recordUpdate(active._id, before, patch);
  };

  const removeActive = async () => {
    if (!active) return;
    history.recordRemove(active._id, asInput(active));
    await removePlacement({ id: active._id });
    setSelected(null);
  };

  const roomStatus = error ? error
    : roomReady ? "Ready"
    : world?.splatUrl ? "Loading room…"
    : world?.status === "generating" ? (world.stage ?? "Building your world…")
    : world?.status === "failed" ? `World generation failed: ${world.error ?? "unknown error"}`
    : "No room loaded";
  // Any number of sketches may already be generating in the background — that never blocks
  // drawing the next one, or leaving to place something already in the library.
  const canDraw = roomReady && !submitting;

  // H is the whole mode switch: walking or drawing, nothing in between. The panel is still one
  // Esc away, because the browser drops pointer lock on Escape by itself.
  const toggleDrawMode = useCallback(() => {
    if (drawing) { leaveDrawing(); return; }
    if (!canDraw) return;
    beginDrawing();
  }, [beginDrawing, canDraw, drawing, leaveDrawing]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code !== "KeyH" || e.repeat || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      toggleDrawMode();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [toggleDrawMode]);

  return <div className="local-editor">
    <header className="viewer-toolbar" inert={!!drawing}>
      <div className="brand"><span className="brand-mark">◎</span><div>doodleforge</div></div>
      <nav aria-label="Room controls">
        <button disabled={!!drawing || !paused} onClick={() => { cancel(); resumeWalking(); }}>Resume look</button>
        <button className="primary" disabled={!!drawing || !canDraw}
          title={roomReady ? "Sketch an object into the room" : roomStatus} onClick={toggleDrawMode}>Draw an object {!isTouch && <kbd>H</kbd>}</button>
        <button aria-expanded={libraryOpen} aria-controls="object-library" onClick={() => setLibraryOpen((v) => !v)}>Objects <span className="count">{placements.length}</span></button>
      </nav>
    </header>

    {!drawing && <ExistingWorlds worlds={worlds} activeId={world?._id} onSelect={selectWorld} corner="bottom-right" />}

    <aside id="object-library" className={`editor-panel ${libraryOpen ? "open" : ""}`} inert={!libraryOpen || !!drawing}>
      <div className="section-heading"><h2>Objects &amp; placement</h2><button aria-label="Close objects" onClick={() => setLibraryOpen(false)}>×</button></div>
      <p className="muted room-status" role="status">{roomStatus}</p>

      <div className="row">
        <button onClick={() => setReset((n) => n + 1)}>Reset view</button>
        <button onClick={onNewWorld}>New world</button>
      </div>
      <div className="row">
        <span className="save-status">room <b>{room}</b></span>
        {joined ? <span className="save-status">joined</span>
          : <button onClick={async () => { await join({ room, sessionId, name: "me", color: randomColor() }); setJoined(true); }}>Join multiplayer</button>}
      </div>
      <p className="controls-help">{isTouch
        ? <>Drag the room to look · Draw an object to sketch<br />Joystick to walk · push further to run</>
        : <>Click room to capture mouse · <kbd>H</kbd> to draw · <kbd>Esc</kbd> for this panel<br />W/A/S/D walk · Q/E down/up · Shift for speed</>}</p>

      {error && <div role="alert" className="error">{error}<button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}

      <section>
        <div className="section-heading"><h2>Object library</h2><span>{readyAssets.length}</span></div>
        <p className="hint">Objects live in this world's backend, so everyone in the room sees them.</p>
        {!readyAssets.length && <p className="hint">Nothing generated yet. Use <b>Draw an object</b>.</p>}
        {readyAssets.map((asset) => <div className="model-row" key={asset._id}>
          <span title={asset.description ?? asset.prompt}>{(asset.description ?? asset.prompt).slice(0, 40)}</span>
          <a href={asset.glbUrl!} download={`${safeFilename(asset.description ?? asset.prompt)}.glb`} title="Download the GLB with its textures">↓</a>
          <button disabled={exporting} title={`Geometry-only STL, ${PRINT_HEIGHT_MM} mm tall`} onClick={() => void downloadStl(asset.glbUrl!, asset.description ?? asset.prompt)}>STL</button>
          <button onClick={() => arm(asset._id, asset.glbUrl!)}>Place</button>
        </div>)}
      </section>

      {armed && <section className="placing-panel">
        <div className="section-heading"><h2>{armed.movingId ? "Move object" : "Place object"}</h2><button onClick={cancel}>Cancel</button></div>
        <p role="status">{!previewReady ? "Loading preview…" : ghost ? `On a ${ghost.kind} · ${ghost.source === "collider" ? "room mesh" : "splat"} · size ×${ghost.scale.toFixed(2)}` : "Move the cursor over a room surface"}</p>
        <TransformKeys isTouch={isTouch} />
        <label className="field">Size <NumberInput label="Preview size" value={armed.targetSize} min={0.02} max={10} step={0.05} onChange={(value) => setArmed({ ...armed, targetSize: value })} /></label>
        <label className="field">Turn <NumberInput label="Preview rotation" value={yaw} min={-360} max={360} step={15} onChange={setYaw} />°</label>
        <p className="hint">The object follows whatever is under the cursor: standing on floors and table tops, flat against walls, hanging from ceilings.</p>
      </section>}

      <section>
        <div className="section-heading"><h2>In this room</h2><span>{placements.length}</span></div>
        <div className="row">
          <button disabled={!history.canUndo || !!armed} onClick={() => void history.undo()}>Undo</button>
          <button disabled={!history.canRedo || !!armed} onClick={() => void history.redo()}>Redo</button>
          <button className="danger" disabled={!placements.length}
            onClick={async () => {
              if (!confirm(`Remove all ${placements.length} objects from this room? This cannot be undone.`)) return;
              try {
                await clearRoom({ room });
                history.clear(); setSelected(null); setJobs([]); setFacingByAsset({});
              } catch (e) { setError(`Could not clear the room: ${e instanceof Error ? e.message : String(e)}`); }
            }}>Clear all</button>
        </div>
        {!placements.length && <p className="hint">Choose Place above, then click a table or the floor.</p>}
        {placements.map((p, i) => <button className={`object-row ${p._id === selected ? "selected" : ""}`} key={p._id} onClick={() => { cancel(); setSelected(p._id); }}>
          <span>{(assets.find((a) => a._id === p.assetId)?.description ?? "Object").slice(0, 28)}</span><span>#{i + 1}</span>
        </button>)}
      </section>

      {active && !armed && <section className="selection-panel">
        <h2>Selected object</h2>
        <div className="row wrap">
          <button disabled={!active.glbUrl} onClick={() => arm(active.assetId, active.glbUrl!, active._id)}>Move</button>
          <button disabled={!active.glbUrl} onClick={() => arm(active.assetId, active.glbUrl!)}>Place another</button>
          <button className="danger" onClick={() => void removeActive()}>Remove</button>
        </div>
        <label className="field">Scale <NumberInput label="Object scale" value={active.scale} min={0.05} max={20} step={0.1} onChange={(scale) => void editActive({ scale })} /></label>
        {(["X", "Y", "Z"] as const).map((axis, index) => <label className="field" key={axis}>{axis} position <NumberInput label={`${axis} position`} value={active.position[index]} min={-1000} max={1000} step={0.05} onChange={(value) => { const position = [...active.position]; position[index] = value; void editActive({ position }); }} /></label>)}
        {(["Tilt", "Turn", "Roll"] as const).map((axis, index) => <label className="field" key={axis}>{axis} <NumberInput label={`Object ${axis.toLowerCase()}`} value={active.rotation[index] * 180 / Math.PI} min={-360} max={360} step={15} onChange={(value) => { const rotation = [...active.rotation]; rotation[index] = value * Math.PI / 180; void editActive({ rotation }); }} />°</label>)}
        <button onClick={() => void editActive({ rotation: [0, active.rotation[1], 0] })}>Stand upright</button>
      </section>}

      <details><summary>World &amp; surfaces</summary>
        <label className="check"><input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} />Show room collider</label>
        <p className="hint">Placement follows the reconstructed collider, falling back to splat surfaces. Sizes are in room metres; this is visual placement, not a physical calibration.</p>
        <input ref={zipInput} type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadWorldZip(f); }} />
        <button onClick={() => zipInput.current?.click()}>Upload world .zip</button>
        {zipStatus && <p className="hint">{zipStatus}</p>}
        <textarea value={worldPrompt} onChange={(e) => setWorldPrompt(e.target.value)} rows={2} aria-label="World prompt" />
        <button disabled={generatingWorld || !worldPrompt.trim()} onClick={() => void generateWorld()}>{generatingWorld ? "Building your space…" : "Generate a world"}</button>
        {worlds.map((w) => <button className="object-row" key={w._id} disabled={w.status !== "ready"} onClick={() => selectWorld(w._id)}>
          <span>{w.name}{w.splatFileName ? ` · ${w.splatFileName.replace(/^splat-|\.spz$/g, "")}` : ""}</span><span>{w.status}</span>
        </button>)}
        {debug && <DebugPanel settings={cfg} onChange={setCfg} />}
      </details>
    </aside>

    <main className="room-canvas" aria-label="3D room"
      onPointerDown={(e) => {
        // Clicking the room is how you get back to walking. <Walk> cannot do this itself:
        // its `paused` also covers placement, where a click must place rather than re-lock.
        if (e.button === 0 && paused && !armed && !drawing && e.target instanceof HTMLCanvasElement) resumeWalking();
      }}>
      {placementsResult !== undefined && jobs.map((job) => <JobWatcher key={job.assetId} job={job} asset={assets.find((a) => a._id === job.assetId)}
        alreadyPlaced={placements.some((p) => p.assetId === job.assetId)}
        room={room} solveRef={solveRef} arm={arm} place={place} history={history}
          store={store} orient={orient} debug={debug} vision={vision} onPlaced={onJobPlaced} onError={setError} />)}
      <Canvas frameloop={drawing ? "never" : "always"} dpr={1} gl={{ antialias: false }} camera={{ position: [0, 1.6, 0], fov: 65, near: 0.02, far: 500 }}>
        <SparkSetup onError={setError} />
        <DrawingBridge captureRef={captureRef} />
        <SketchSolver solveRef={solveRef} />
        <ambientLight intensity={1.4} />
        <directionalLight position={[3, 5, 2]} intensity={2} />
        {world?.splatUrl && <SplatWorld url={world.splatUrl} fileName={world.splatFileName ?? undefined}
          metricScale={metricScale} groundOffset={groundOffset} minRaycastOpacity={cfg.minRaycastOpacity}
          onReady={onSplatReady} onError={onSplatError} />}
        {world?.colliderUrl && <ColliderBoundary onError={setError}><Suspense fallback={null}>
          <Collider url={world.colliderUrl} metricScale={metricScale} groundOffset={groundOffset} visible={wireframe} />
        </Suspense></ColliderBoundary>}
        {!world && <gridHelper args={[20, 20]} />}
        {placements.filter((p) => p.glbUrl && p._id !== armed?.movingId).map((p) =>
          // The id rides on a wrapper group so the crosshair can find the placement it hit.
          <group key={p._id} userData={{ placementId: p._id }}>
            <Asset url={p.glbUrl!} position={p.position} rotation={p.rotation} scale={p.scale} targetSize={p.targetSize}
              onClick={armed || !paused || drawing ? undefined : () => editPlacement(p)} onError={setError} />
          </group>)}
        <CrosshairPick enabled={!armed && !drawing && mouseLocked}
          onHit={(id) => { const hit = placements.find((p) => p._id === id); if (hit) editPlacement(hit); }} />
        {jobs.map((job) => {
          if (!job.strokeImage) return null;
          const jobAsset = assets.find((a) => a._id === job.assetId);
          if (!jobAsset || placements.some((p) => p.assetId === jobAsset._id)) return null;
          return <SketchGhost key={job.assetId} anchor={job.anchor} image={job.strokeImage} />;
        })}
        {active && !armed && <mesh position={active.position as [number, number, number]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.035, 0.05, 32]} /><meshBasicMaterial color="#98f5ba" depthTest={false} transparent opacity={0.8} />
        </mesh>}
        {armed && <PlacementGhost key={`${armed.assetId}:${armed.movingId ?? "new"}`} url={armed.url} targetSize={armed.targetSize}
          yaw={yaw * Math.PI / 180} pickHz={12} allow={SURFACES}
          opacity={cfg.ghostOpacity} clickSlop={cfg.clickSlop}
          onPreview={setGhost} onReady={() => setPreviewReady(true)}
          onYawDelta={(radians) => setYaw((degrees) => wrapDegrees(degrees + radians * 180 / Math.PI))}
          onResetRotation={() => setYaw(0)}
          onError={(message) => { setError(message); cancel(); }} onCancel={cancel}
          onCommit={(position, rotation, scale) => {
            const input: PlacementInput = { assetId: armed.assetId, position, rotation, scale, targetSize: armed.targetSize };
            void (async () => {
              if (armed.movingId) {
                const before = placements.find((p) => p._id === armed.movingId);
                await updatePlacement({ id: armed.movingId, position, rotation, scale, targetSize: armed.targetSize });
                if (before) history.recordUpdate(armed.movingId, asInput(before), input);
                setSelected(armed.movingId);
              } else {
                const id = await place({ room, ...input });
                history.recordPlace(id, input);
                setSelected(id);
              }
            })();
            cancel();
          }} />}
        <Walk reset={reset} paused={paused || !!armed} enabled={!drawing} mouseLookRef={mouseLookRef} touchInputRef={touchInputRef}
          onLockChange={(locked) => { setMouseLocked(locked); setPaused(!locked); }} onError={setError} />
        {joined && <Players room={room} sessionId={sessionId} />}
      </Canvas>

      {!drawing && <>
        {isTouch && !paused && !armed && <TouchControls inputRef={touchInputRef} />}
        <div className="canvas-badge"><span className="live-dot" />{roomReady ? "LIVE ROOM" : roomStatus}</div>
        {world && world.status !== "ready" && <div className="world-generation-status" role={world.status === "failed" ? "alert" : "status"}>
          <h2>{world.status === "failed" ? "Your room needs attention" : "Creating your room"}</h2>
          <p>{world.status === "failed" ? world.error : world.stage ?? "Building your world…"}</p>
          {world.status === "generating" && <p className="muted">You can leave this screen and reopen your room from Existing worlds.</p>}
          <div className="row">
            {world.status === "failed" && world.retryable && world.operationId && <button onClick={() => {
              setError("");
              void resumeWorld({ id: world._id }).catch(e => setError(e instanceof Error ? e.message : String(e)));
            }}>Resume generation · no new world charge</button>}
            <button onClick={onNewWorld}>Back to captures</button>
          </div>
        </div>}
        {mouseLocked && <div className="crosshair" />}
        {!paused && !mouseLocked && !isTouch && <div className="paused-hint">Click the room to explore · H to draw</div>}
        {!armed && (isTouch
          ? <div className="walk-hint"><span>Drag to look · joystick to move</span><span>Draw an object to sketch</span></div>
          : <div className="walk-hint"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Walk</span><span><kbd>Q</kbd><kbd>E</kbd> Fly</span><span><kbd>Shift</kbd> Faster</span><span><kbd>H</kbd> Draw</span>{mouseLocked && <span>Click an object to edit</span>}</div>)}
        {paused && !armed && !jobs.length && roomReady && <div className="paused-hint">{isTouch
          ? "Tap Draw an object to sketch into this room"
          : "Press H to draw something into this room"}</div>}
        {armed && <div className="armed-hud"><strong>{armed.movingId ? "Editing object" : "Placing object"}</strong><TransformKeys isTouch={isTouch} /></div>}
        {error && !libraryOpen && <div className="floating-error" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}

        {(jobs.length > 0 || submitting) && <div className="generation-stack">
          {submitting && <div className="generation-card" aria-live="polite">
            <div className="generation-content">
              <div className="section-heading"><strong>Sending drawing</strong></div>
              <p>Uploading your sketch…</p>
            </div>
          </div>}
          {jobs.map((job) => {
            const jobAsset = assets.find((a) => a._id === job.assetId);
            const stage = jobAsset?.stage ?? "image";
            const generating = jobAsset?.status === "generating";
            const jobPlaced = Boolean(jobAsset && placements.some((p) => p.assetId === jobAsset._id));
            const jobInHand = Boolean(jobAsset && armed?.assetId === jobAsset._id);
            const facing = facingByAsset[job.assetId] ?? null;
            const elapsed = Math.max(0, (now - job.startedAt) / 1000);
            // On a phone this card is large relative to the screen and stacks over the corner
            // controls, so a finished job clears itself instead of needing the extra tap.
            // Never for a failure — that card carries the error and the Resume task button, and
            // vanishing it would hide a real problem — nor while the object is armed, when the
            // card is showing live placement instructions.
            const autoDismiss = isTouch && !generating && !jobInHand
              && jobAsset?.status !== "failed" && (jobPlaced || jobAsset?.status === "ready");
            return <div className="generation-card" key={job.assetId} aria-live="polite">
              <AutoDismiss when={autoDismiss} delayMs={4000} onFire={() => dismissJob(job.assetId)} />
              {jobAsset?.cutoutUrl && <img src={jobAsset.cutoutUrl} alt="Generated object" />}
              <div className="generation-content">
                <div className="section-heading">
                  <strong>{jobInHand ? "Ready to place" : jobPlaced ? "Placed where you drew it" : jobAsset?.status === "ready" ? "In your library"
                    : jobAsset?.status === "failed" ? "Generation failed" : "Creating your object"}</strong>
                  {generating && <span>{elapsed.toFixed(0)}s{typeof jobAsset?.progress === "number" ? ` · ${jobAsset.progress}%` : ""}</span>}
                </div>
                {/* While generating on a phone the stage pills below already say everything this
                    paragraph would, and the card is competing for a small screen — drop it and
                    let the card collapse to heading + elapsed + stages. Terminal states keep it:
                    that is where the error text and the what-to-do-next copy live. */}
                {!(isTouch && generating) && <p>{jobAsset?.error || (jobInHand ? "Move over a room surface, then click to place."
                  : jobPlaced ? (facing === "vision" || facing === "sketched" ? "Turned to face the way you sketched it."
                    : facing === "camera" ? "Facing you — the shape was too symmetric to tell which way round it goes."
                    : facing === "unavailable" ? "Facing you — orientation matching is unavailable on this deployment."
                    : "Select your object to adjust it.")
                  : jobAsset?.status === "ready" ? "Choose Place when you're ready."
                  : "Klein cleans up your sketch, then Tripo builds it with colour.")}</p>}
                {generating && <div className="pipeline-steps">{STAGES.map(([key, label]) =>
                  <span key={key} className={key === stage ? "current" : ""}>{label}</span>)}</div>}
                <div className="row wrap">
                  {jobPlaced && jobAsset?.glbUrl && <button onClick={() => {
                    const placed = placements.find((p) => p.assetId === jobAsset._id);
                    if (placed) arm(placed.assetId, jobAsset.glbUrl!, placed._id);
                  }}>Move</button>}
                  {jobPlaced && <button disabled={!history.canUndo || !!armed} onClick={() => void history.undo()}>Undo</button>}
                  {jobAsset?.status === "ready" && !jobInHand && !jobPlaced && jobAsset.glbUrl &&
                    <button onClick={() => arm(jobAsset._id, jobAsset.glbUrl!)}>Place object</button>}
                  {jobAsset?.glbUrl && <a download={`${safeFilename(jobAsset.description ?? "object")}.glb`} href={jobAsset.glbUrl}>Color GLB ↗</a>}
                  {jobAsset?.glbUrl && <button disabled={exporting} onClick={() => void downloadStl(jobAsset.glbUrl!, jobAsset.description ?? "object")}>{exporting ? "Exporting…" : "STL · no color ↗"}</button>}
                  {jobAsset?.status === "failed" && jobAsset.taskId && <button onClick={() => void resumeSketch({ assetId: jobAsset._id })}>Resume task</button>}
                  {!generating && <button onClick={() => dismissJob(job.assetId)}>Done</button>}
                </div>
              </div>
            </div>;
          })}
        </div>}
      </>}
      {drawing && <DrawingLayer capture={drawing} onCancel={leaveDrawing} onGenerate={submitDrawing}
        blocked={submitting} errorMessage={error} isTouch={isTouch} />}
    </main>
  </div>;
}

/**
 * Watches one sketch job from "generating" to placed, independently of every other job — this
 * is what lets several sketches be drawn and generating at once. One instance is mounted per
 * job (keyed by assetId), each with its own `placedRef`, so a finished mesh is auto-placed
 * exactly once no matter how many other jobs are in flight alongside it.
 *
 * The anchor already holds a real contact point and a surface-aligned rotation, measured
 * against the collider when the drawing was made — it only ever needed to be used. What the
 * anchor cannot know is which way round the object faces, because Klein re-poses the cutout
 * into a centred product view; SketchSolver recovers that by matching rendered silhouettes
 * against the user's ink. A symmetric object has no answer to recover, so it keeps the yaw
 * orientOnSurface already gave it rather than snapping to a coin-flip.
 */
function JobWatcher({ job, asset, alreadyPlaced, room, solveRef, arm, place, history, store, orient, debug, vision, onPlaced, onError }: {
  job: JobEntry;
  asset: AssetDoc | undefined;
  alreadyPlaced: boolean;
  room: string;
  solveRef: React.MutableRefObject<SketchSolverApi | null>;
  arm: (assetId: Id<"assets">, url: string, movingId?: Id<"placements">, suggestedSize?: number) => void;
  place: PlaceFn;
  history: History;
  store: (dataUrl: string) => Promise<Id<"_storage">>;
  orient: PoseTools["orient"];
  debug: boolean;
  vision: boolean;
  onPlaced: (assetId: Id<"assets">, placementId: Id<"placements">, facing: Facing) => void;
  onError: (message: string) => void;
}) {
  // StrictMode runs this twice on mount, and a reload can restore an already-finished job.
  // Claiming the placement up front stops a double placement; releasing it again on a run
  // that never reached `place` stops the discarded first run from swallowing the object.
  const placedRef = useRef(false);
  useEffect(() => {
    if (!asset || asset.status !== "ready" || !asset.glbUrl || placedRef.current || alreadyPlaced) return;
    placedRef.current = true;
    let alive = true, committed = false;
    void (async () => {
      const url = asset.glbUrl!;
      let input: PlacementInput | null = null;
      let facing: Facing = "camera";
      try {
        const gltf = await gltfLoader.loadAsync(url);
        try {
          const pose = await resolveSketchPose(gltf.scene, job.anchor, asset.description ?? asset.prompt,
            { solver: solveRef.current, store, orient, vision });
          facing = pose.facing;
          if (debug) console.info("[sketch orientation]", asset._id, pose.facing, pose.debug);
          input = {
            assetId: asset._id,
            position: pose.position, rotation: pose.rotation, scale: 1, targetSize: pose.targetSize,
          };
        } finally { disposeModel(gltf.scene); }
      } catch {
        // No pose could be derived (empty geometry, or the GLB would not load). Fall back to
        // placing it by hand rather than dropping the object the user just paid to generate.
      }
      if (!alive) return;
      committed = true;   // no await since the check above, so the cleanup cannot slip in here
      if (!input) { arm(asset._id, url); return; }
      try {
        const id = await place({ room, ...input });
        history.recordPlace(id, input);   // inverse-op stack: Undo removes it, multiplayer-safe
        onPlaced(asset._id, id, facing);
      } catch (e) {
        onError(`Could not place your object: ${e instanceof Error ? e.message : String(e)}`);
        arm(asset._id, url, undefined, input.targetSize);
      }
    })();
    return () => { alive = false; if (!committed) placedRef.current = false; };
  }, [job, asset, alreadyPlaced, room, solveRef, arm, place, history, store, orient, debug, vision, onPlaced, onError]);
  return null;
}

/** Keeps the Turn field inside the range its number input accepts as Q/E accumulate. */
function wrapDegrees(degrees: number) {
  return ((degrees + 180) % 360 + 360) % 360 - 180;
}

/**
 * Fires `onFire` once, `delayMs` after `when` turns true, and cancels if `when` goes back to
 * false first. Renders nothing: it exists so each generation card owns its own timer instead of
 * the parent juggling a map of them across the re-render it does every second (the `now`
 * ticker) and on every Convex query update. `onFire` is read through a ref so an inline arrow
 * at the call site can't restart the timer on each of those re-renders.
 */
function AutoDismiss({ when, delayMs, onFire }: { when: boolean; delayMs: number; onFire: () => void }) {
  const fire = useRef(onFire);
  fire.current = onFire;
  useEffect(() => {
    if (!when) return;
    const timer = window.setTimeout(() => fire.current(), delayMs);
    return () => clearTimeout(timer);
  }, [when, delayMs]);
  return null;
}

/** The keys that move an armed object. Shown in the panel and over the canvas. */
function TransformKeys({ isTouch }: { isTouch: boolean }) {
  if (isTouch) return <ul className="key-legend">
    <li>Turn / Size fields below</li>
    <li>Tap a surface to place</li>
    <li>Cancel button to back out</li>
  </ul>;
  return <ul className="key-legend">
    <li><kbd>Q</kbd><kbd>E</kbd> Turn <small>Shift: fine</small></li>
    <li><kbd>[</kbd><kbd>]</kbd> Resize <small>or scroll</small></li>
    <li><kbd>R</kbd> Reset turn</li>
    <li><kbd>Enter</kbd> / click Place</li>
    <li><kbd>Esc</kbd> Cancel</li>
  </ul>;
}

/**
 * Left-click while walking edits whatever the crosshair is on, so an object already in the
 * room is one click from the same UI that placed it — no need to release the mouse first.
 */
function CrosshairPick({ enabled, onHit }: { enabled: boolean; onHit: (id: string) => void }) {
  const { gl, camera, scene } = useThree();
  const cb = useRef({ enabled, onHit });
  cb.current = { enabled, onHit };
  useEffect(() => {
    const el = gl.domElement;
    const centre = new THREE.Vector2(0, 0);
    const click = () => {
      if (!cb.current.enabled || document.pointerLockElement !== el) return;
      const targets: THREE.Object3D[] = [];
      scene.traverse((o) => { if (o.userData.placementId) targets.push(o); });
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(centre, camera);
      const hit = raycaster.intersectObjects(targets, true)[0];
      if (!hit) return;
      // Room geometry in front of the object wins: you cannot edit through a wall.
      const room = pickSurface(new THREE.Raycaster(), camera, centre, scene, SURFACES);
      if (room && room.point.distanceTo(camera.position) < hit.distance) return;
      for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) {
        if (node.userData.placementId) { cb.current.onHit(node.userData.placementId as string); return; }
      }
    };
    el.addEventListener("click", click);
    return () => el.removeEventListener("click", click);
  }, [gl, camera, scene]);
  return null;
}

/** `history` is taken by the placement stack, so URL rewrites go through this. */
function history_replace(url: URL) {
  window.history.replaceState(null, "", url);
}

function NumberInput({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(3))));
  useEffect(() => setDraft(String(Number(value.toFixed(3)))), [value]);
  const commit = () => {
    const next = Number(draft);
    if (draft.trim() && Number.isFinite(next)) {
      const clamped = Math.min(max, Math.max(min, next));
      if (clamped !== value) onChange(clamped);
      setDraft(String(Number(clamped.toFixed(3))));
    } else setDraft(String(Number(value.toFixed(3))));
  };
  return <input aria-label={label} type="number" value={draft} min={min} max={max} step={step} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); }} />;
}
