import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useThree } from "@react-three/fiber";
import { PerspectiveCamera, type Object3D } from "three";
import { anchorDrawing, contactPoint, drawingBounds, type DrawingAnchor, type DrawingBounds, type Point, type Stroke } from "../lib/drawingPlacement";

export type DrawingCapture = { image: HTMLCanvasElement; anchor: (strokes: Stroke[]) => DrawingAnchor };
// `strokeImage` is the ink alone on transparency, cropped to `anchor.bounds`, so it can be
// hung back in the room on the quad those same bounds unproject to (see SketchGhost). The
// anchor separately carries the strokes as polylines, which is what sketchOrientation matches
// the generated mesh against — a cropped bitmap has lost the frame it was drawn in.
export type DrawingRequest = { image: string; cleanImage: string; strokeImage: string; description: string; anchor: DrawingAnchor };
export function DrawingBridge({ captureRef }: { captureRef: React.MutableRefObject<(() => DrawingCapture) | null> }) {
  const { gl, camera, scene } = useThree();
  useEffect(() => {
    captureRef.current = () => {
      // A sketch still generating in the background leaves its ink hanging in the room
      // (SketchGhost). It has to stay out of this capture: it is not this drawing's context,
      // and Klein is told to read colored ink as instructions, so another sketch's leftover
      // marks would bleed into this one's reference images.
      const hiddenGhosts: Object3D[] = [];
      scene.traverse((o) => { if (o.userData.sketchGhost && o.visible) { hiddenGhosts.push(o); o.visible = false; } });
      try {
        gl.render(scene, camera);
      } finally {
        for (const o of hiddenGhosts) o.visible = true;
      }
      const image = document.createElement("canvas");
      // One capped snapshot avoids Retina-sized uploads and retains the viewport's aspect.
      const ratio = Math.min(1, 1280 / Math.max(gl.domElement.width, gl.domElement.height));
      image.width = Math.round(gl.domElement.width * ratio); image.height = Math.round(gl.domElement.height * ratio);
      image.getContext("2d")!.drawImage(gl.domElement, 0, 0, image.width, image.height);
      const frozen = (camera as PerspectiveCamera).clone();
      return { image, anchor: (strokes) => anchorDrawing(strokes, frozen, scene) };
    };
    return () => { captureRef.current = null; };
  }, [gl, camera, scene, captureRef]);
  return null;
}

const INK = "#ff5488";
export function DrawingLayer({ capture, onCancel, onGenerate, blocked, errorMessage, isTouch = false }: { capture: DrawingCapture; onCancel: () => void; onGenerate: (request: DrawingRequest) => Promise<void>; blocked: boolean; errorMessage: string; isTouch?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const current = useRef<{ stroke: Stroke; pointerId: number } | null>(null);
  const [revision, setRevision] = useState(0);
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [anchor, setAnchor] = useState<DrawingAnchor | null>(null);
  const bounds = drawingBounds(strokes.current);
  /** Shared by the on-screen canvas and the cropped cutout, so the two never drift. */
  function paintStrokes(ctx: CanvasRenderingContext2D, width: number, height: number) {
    ctx.strokeStyle = ctx.fillStyle = INK;
    ctx.lineCap = ctx.lineJoin = "round";
    for (const s of strokes.current) {
      ctx.lineWidth = s.width * width;
      ctx.beginPath();
      const first = s.points[0];
      ctx.moveTo(first.x * width, first.y * height);
      for (const p of s.points) ctx.lineTo(p.x * width, p.y * height);
      if (s.points.length === 1) { ctx.arc(first.x * width, first.y * height, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); }
      else ctx.stroke();
    }
  }
  function render() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(capture.image, 0, 0, canvas.width, canvas.height);
    paintStrokes(ctx, canvas.width, canvas.height);
  }
  /** The ink alone, on transparency, cropped to exactly the bounds rectangle. */
  function strokeCutout(box: DrawingBounds) {
    const source = canvasRef.current!;
    const left = Math.floor(box.left * source.width);
    const top = Math.floor(box.top * source.height);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.ceil((box.right - box.left) * source.width));
    out.height = Math.max(1, Math.ceil((box.bottom - box.top) * source.height));
    const ctx = out.getContext("2d")!;
    ctx.translate(-left, -top);
    paintStrokes(ctx, source.width, source.height);
    return out.toDataURL("image/png");
  }
  function refreshAnchor() {
    setAnchor(null); setError("");
    if (drawingBounds(strokes.current)) {
      try { setAnchor(capture.anchor(strokes.current)); }
      catch (e) { setError((e as Error).message); }
    }
    setRevision((n) => n + 1);
  }
  useEffect(render, [capture, revision]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);
  function point(e: ReactPointerEvent<HTMLCanvasElement>): Point {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) };
  }
  function end(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (current.current?.pointerId !== e.pointerId) return;
    current.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    refreshAnchor();
  }
  return <div className="drawing-layer" role="region" aria-label="Draw an object in the room">
    <canvas ref={canvasRef} width={capture.image.width} height={capture.image.height} aria-label="Drawing canvas"
      onPointerDown={(e) => {
        if (e.button !== 0 || current.current) return;
        e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
        const stroke = { points: [point(e)], width: 3 / e.currentTarget.getBoundingClientRect().width };
        current.current = { stroke, pointerId: e.pointerId }; strokes.current.push(stroke); render();
      }}
      onPointerMove={(e) => { if (current.current?.pointerId === e.pointerId) { current.current.stroke.points.push(point(e)); render(); } }}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} />
    <div className="drawing-heading"><span className="live-dot" />DRAW IN YOUR ROOM<span>Outline an object. Let its base touch a surface.</span></div>
    {bounds && <div className="drawing-bounds" style={{ left: `${bounds.left * 100}%`, top: `${bounds.top * 100}%`, width: `${(bounds.right - bounds.left) * 100}%`, height: `${(bounds.bottom - bounds.top) * 100}%` }}>
      <span className={anchor ? "anchor valid" : "anchor"} title="Object contact point"
        style={{ left: `${(contactPoint(strokes.current, bounds).x - bounds.left) / (bounds.right - bounds.left) * 100}%` }} /></div>}
    <form className="drawing-composer" onSubmit={(e) => {
      e.preventDefault();
      if (blocked || !bounds || !anchor || !description.trim() || current.current) return;
      void onGenerate({ image: canvasRef.current!.toDataURL("image/png"), cleanImage: capture.image.toDataURL("image/png"),
        strokeImage: strokeCutout(anchor.bounds), description: description.trim(), anchor });
    }}>
      <div className="drawing-tools"><span>{anchor ? "Anchored to a real surface · it'll be placed where you drew it" : "Draw the object's outline"}</span>
        <button type="button" disabled={!strokes.current.length} onClick={() => { strokes.current.pop(); refreshAnchor(); }}>Undo stroke</button>
        <button type="button" disabled={!strokes.current.length} onClick={() => { strokes.current = []; refreshAnchor(); }}>Clear</button>
        {/* The Escape key handler above stays wired up either way — a phone can have a
            bluetooth keyboard; only the hint goes, since most touch users have no Esc key. */}
        <button type="button" onClick={onCancel}>Cancel {!isTouch && <kbd>Esc</kbd>}</button>
      </div>
      <div className="composer-row"><input aria-label="Describe your object" placeholder="What are you imagining? A faceted ceramic pot…" value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} required />
        <button className="primary" disabled={blocked || !anchor || !description.trim()} type="submit">{blocked ? "Sending drawing…" : "Create in room"} <span>↗</span></button></div>
      <p role="status" className={error || errorMessage ? "error-text" : "hint"}>{errorMessage || error || "Image → color GLB → placed where you drew it · Keep exploring while it builds."}</p>
    </form>
  </div>;
}
