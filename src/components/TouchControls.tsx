import { useEffect, useRef, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import type { TouchInput } from "./LocalWalk";

const JOYSTICK_RADIUS = 44;

/**
 * DOM overlay for touch devices, standing in for pointer-lock look + WASD. Renders only while
 * `Walk`'s frame loop is active (not paused, not placing, not drawing) so it never competes
 * with PlacementGhost's or DrawingLayer's own pointer handling, which already work by touch.
 * A left-side joystick drives movement; dragging anywhere else looks around, mirroring the
 * mousemove math `Walk` already uses for locked pointer input.
 */
export function TouchControls({ inputRef }: { inputRef: MutableRefObject<TouchInput> }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLDivElement>(null);
  const nubRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const base = baseRef.current;
    const nub = nubRef.current;
    if (!root || !base || !nub) return;
    const abort = new AbortController();
    const options = { signal: abort.signal };

    let joystickId: number | null = null;
    let joystickCenter = { x: 0, y: 0 };
    // Up to two non-joystick pointers: one is single-finger drag-to-look, two is pinch-to-zoom.
    // Each entry's {x,y} is kept current by that pointer's own move events, which is what lets
    // dropping back from two fingers to one resume look-dragging with no jump — the surviving
    // pointer's stored position is already exactly where it is right now.
    const lookPointers = new Map<number, { x: number; y: number }>();
    let lastPinchDist: number | null = null;

    const setNub = (dx: number, dy: number) => { nub.style.transform = `translate(${dx}px, ${dy}px)`; };

    const updateJoystick = (x: number, y: number) => {
      let dx = x - joystickCenter.x;
      let dy = y - joystickCenter.y;
      const dist = Math.hypot(dx, dy);
      if (dist > JOYSTICK_RADIUS) { dx = (dx / dist) * JOYSTICK_RADIUS; dy = (dy / dist) * JOYSTICK_RADIUS; }
      setNub(dx, dy);
      inputRef.current.moveX = dx / JOYSTICK_RADIUS;
      inputRef.current.moveZ = dy / JOYSTICK_RADIUS;
    };

    const onPointerDown = (e: PointerEvent) => {
      const rect = base.getBoundingClientRect();
      const pad = 24; // generous catch radius so a thumb near the base still grabs it
      const overJoystick = joystickId === null &&
        e.clientX >= rect.left - pad && e.clientX <= rect.right + pad &&
        e.clientY >= rect.top - pad && e.clientY <= rect.bottom + pad;
      root.setPointerCapture(e.pointerId);
      if (overJoystick) {
        joystickId = e.pointerId;
        joystickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        updateJoystick(e.clientX, e.clientY);
      } else if (lookPointers.size < 2) {
        lookPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (lookPointers.size === 2) {
          const [a, b] = [...lookPointers.values()];
          lastPinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        }
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId === joystickId) { updateJoystick(e.clientX, e.clientY); return; }
      const pt = lookPointers.get(e.pointerId);
      if (!pt) return;
      if (lookPointers.size < 2) {
        inputRef.current.lookDX += e.clientX - pt.x;
        inputRef.current.lookDY += e.clientY - pt.y;
        pt.x = e.clientX; pt.y = e.clientY;
        return;
      }
      // Two fingers down: pinch-to-zoom. Look accumulation is suspended entirely while
      // pinching — blending rotation and zoom from the same two-finger drag reads as chaotic
      // camera motion — and resumes once back to one finger.
      pt.x = e.clientX; pt.y = e.clientY;
      const [a, b] = [...lookPointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinchDist !== null) {
        // Fingers spreading apart (distance growing) reads as "zoom in", matching the
        // standard photo/map pinch convention; Walk's useFrame turns a positive delta here
        // into a smaller camera.fov.
        inputRef.current.pinchDelta += dist - lastPinchDist;
      }
      lastPinchDist = dist;
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId === joystickId) {
        joystickId = null;
        inputRef.current.moveX = 0;
        inputRef.current.moveZ = 0;
        setNub(0, 0);
      }
      if (lookPointers.has(e.pointerId)) {
        lookPointers.delete(e.pointerId);
        lastPinchDist = null;
      }
    };

    root.addEventListener("pointerdown", onPointerDown, options);
    root.addEventListener("pointermove", onPointerMove, options);
    root.addEventListener("pointerup", onPointerUp, options);
    root.addEventListener("pointercancel", onPointerUp, options);
    return () => {
      abort.abort();
      inputRef.current.moveX = 0;
      inputRef.current.moveZ = 0;
      inputRef.current.lookDX = 0;
      inputRef.current.lookDY = 0;
      inputRef.current.flyY = 0;
      inputRef.current.pinchDelta = 0;
    };
  }, [inputRef]);

  return (
    <div ref={rootRef} className="touch-controls">
      <div ref={baseRef} className="touch-joystick-base">
        <div ref={nubRef} className="touch-joystick-nub" />
      </div>
      <div className="touch-fly-controls">
        <FlyButton dir={1} inputRef={inputRef} label="Fly up" glyph="▲" />
        <FlyButton dir={-1} inputRef={inputRef} label="Fly down" glyph="▼" />
      </div>
    </div>
  );
}

// Discrete press-and-hold buttons, not part of the joystick/look surface: each stops
// propagation so `root`'s pointerdown handler above never mistakes a tap here for the start
// of a look-drag, and captures its own pointer so dragging off the button still releases it.
function FlyButton({ dir, inputRef, label, glyph }: { dir: 1 | -1; inputRef: MutableRefObject<TouchInput>; label: string; glyph: string }) {
  const press = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    inputRef.current.flyY = dir;
  };
  const release = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    inputRef.current.flyY = 0;
  };
  return (
    <button type="button" className="touch-fly-button" aria-label={label}
      onPointerDown={press} onPointerUp={release} onPointerCancel={release} onPointerLeave={release}
      onContextMenu={(e) => e.preventDefault()}>
      {glyph}
    </button>
  );
}
