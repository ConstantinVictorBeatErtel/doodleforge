import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { MathUtils, Vector3, type PerspectiveCamera } from "three";

const UP = new Vector3(0, 1, 0);
// Metres per second. The room now carries Marble's metric scale, so these are real
// walking speeds rather than the arbitrary units the standalone viewer used.
const WALK_SPEED = 1.6;
const SPRINT_MULTIPLIER = 3;
// Standing eye height. The capture origin is on the floor, not at head level.
const SPAWN: [number, number, number] = [0, 1.6, 0];
// Pinch-to-zoom FOV range and feel. 65 (the Canvas default) sits in the middle so pinching
// either direction from a fresh load has room to move.
const MIN_FOV = 30;
const MAX_FOV = 100;
const PINCH_DEGREES_PER_PIXEL = 0.15;

export type MouseLook = { capture: () => void; release: () => void };
// Drained every frame by Walk: TouchControls accumulates lookDX/lookDY/pinchDelta between
// frames and holds moveX/moveZ/flyY live while the joystick/fly buttons are held. Zero when
// no touch input is active, so desktop's keyboard/mouse path is unaffected by simply always
// reading this ref. flyY is -1/0/1, mirroring the Q/E fly-up/down keys for touch. pinchDelta
// is the accumulated change in on-screen distance between two fingers (px) since it was last
// drained — positive means the fingers spread apart (zoom in).
export type TouchInput = { moveX: number; moveZ: number; lookDX: number; lookDY: number; flyY: number; pinchDelta: number };

// iOS Safari (and any iOS WKWebView, including Capacitor/Expo wrappers) never implements the
// Pointer Lock API on touch-first devices — it's a WebKit engine restriction, not fixed by a
// native shell. Attempting requestPointerLock() there just fails and surfaces an error, so we
// skip it entirely and rely on TouchControls' drag-to-look + joystick instead.
const isTouchDevice = () =>
  typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)")?.matches ?? false);

export function Walk({ reset, paused = false, enabled = true, mouseLookRef, touchInputRef, onLockChange, onError }: {
  reset: number; paused?: boolean; enabled?: boolean;
  mouseLookRef: MutableRefObject<MouseLook | null>; touchInputRef?: MutableRefObject<TouchInput>;
  onLockChange: (locked: boolean) => void; onError: (message: string) => void;
}) {
  const { camera, gl, size } = useThree();
  const [keys] = useState(() => new Set<string>());
  const [direction] = useState(() => new Vector3());
  const settings = useRef({ paused, enabled, onLockChange, onError });
  settings.current = { paused, enabled, onLockChange, onError };
  useEffect(() => {
    if (paused || !enabled) { mouseLookRef.current?.release(); keys.clear(); }
  }, [paused, enabled, mouseLookRef, keys]);
  useEffect(() => {
    camera.position.set(...SPAWN);
    camera.rotation.set(0, 0, 0, "YXZ");
  }, [camera, reset]);
  useEffect(() => {
    const abort = new AbortController();
    const options = { signal: abort.signal };
    const canvas = gl.domElement;
    const touch = isTouchDevice();
    let wantLock = false;
    let requesting = false;
    const release = () => {
      wantLock = false;
      keys.clear();
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    };
    const failed = (error?: unknown) => {
      if (abort.signal.aborted || !wantLock) return;
      wantLock = false;
      if (error instanceof Error) console.warn("Pointer lock failed:", error.name, error.message);
      settings.current.onLockChange(false);
      settings.current.onError("Mouse capture was unavailable. Click Resume look to try again, or open this viewer in a browser that supports pointer lock.");
    };
    const capture = () => {
      if (touch || !settings.current.enabled || requesting || document.pointerLockElement === canvas) return;
      wantLock = true;
      requesting = true;
      // Called directly from a click or H key, preserving the browser's user gesture.
      try {
        Promise.resolve(canvas.requestPointerLock()).catch(failed).finally(() => { requesting = false; });
      } catch (error) { requesting = false; failed(error); }
    };
    mouseLookRef.current = { capture, release };
    canvas.addEventListener("pointerdown", (e) => {
      if (settings.current.enabled && !settings.current.paused && e.button === 0) capture();
    }, options);
    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === canvas;
      if (locked && !wantLock) { document.exitPointerLock(); return; }
      if (!locked) { wantLock = false; keys.clear(); }
      settings.current.onLockChange(locked);
    }, options);
    document.addEventListener("pointerlockerror", failed, options);
    document.addEventListener("mousemove", (e) => {
      if (!settings.current.enabled || settings.current.paused || document.pointerLockElement !== canvas) return;
      // Relative motion remains unbounded even after the cursor reaches a screen edge.
      camera.rotation.y -= e.movementX * 0.002;
      camera.rotation.x = Math.max(-1.55, Math.min(1.55, camera.rotation.x - e.movementY * 0.002));
    }, options);
    const movement = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);
    window.addEventListener("keydown", (e) => {
      // `paused` covers placement and the drawing overlay: Q/E turn the armed object there,
      // and must not also fly the camera.
      if (!settings.current.enabled || settings.current.paused || (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) || e.metaKey || e.ctrlKey || e.altKey || !movement.has(e.code)) return;
      e.preventDefault();
      if (document.pointerLockElement !== canvas) capture();
      keys.add(e.code);
    }, options);
    window.addEventListener("keyup", (e) => { keys.delete(e.code); }, options);
    window.addEventListener("blur", release, options);
    document.addEventListener("visibilitychange", release, options);
    return () => { abort.abort(); release(); mouseLookRef.current = null; };
  }, [camera, gl, keys, mouseLookRef]);
  useFrame((_, delta) => {
    if (!enabled || paused) return;
    const held = (a: string, b?: string) => Number(keys.has(a) || Boolean(b && keys.has(b)));
    // TouchControls (mounted only on coarse-pointer devices, only while walking) drains its own
    // look deltas here each frame; moveX/moveZ/flyY stay live for as long as the joystick/fly
    // buttons are held. Sign is flipped versus desktop mousemove below: touch drag follows the
    // "drag to pan/pull the world" convention (finger right -> view turns left), the opposite
    // of FPS mouselook, per real-device testing.
    const touch = touchInputRef?.current;
    if (touch && (touch.lookDX || touch.lookDY)) {
      // A true 1:1 drag maps 1px of finger movement to the angle that 1px subtends at the
      // camera's focal length, so the point under your finger roughly tracks your finger
      // instead of the view spinning faster than the drag. Computed fresh each frame (not
      // memoized) since pinch-to-zoom below mutates camera.fov in place on the same camera
      // object, which a dependency-array memo wouldn't notice.
      const fov = (camera as PerspectiveCamera).fov ?? 65;
      const focalLengthPx = (size.height / 2) / Math.tan(MathUtils.degToRad(fov) / 2);
      const touchRadiansPerPixel = 1 / focalLengthPx;
      camera.rotation.y += touch.lookDX * touchRadiansPerPixel;
      camera.rotation.x = Math.max(-1.55, Math.min(1.55, camera.rotation.x + touch.lookDY * touchRadiansPerPixel));
      touch.lookDX = 0; touch.lookDY = 0;
    }
    if (touch && touch.pinchDelta) {
      // Positive pinchDelta = fingers spreading apart = zoom in = smaller FOV.
      const cam = camera as PerspectiveCamera;
      cam.fov = MathUtils.clamp(cam.fov - touch.pinchDelta * PINCH_DEGREES_PER_PIXEL, MIN_FOV, MAX_FOV);
      cam.updateProjectionMatrix();
      touch.pinchDelta = 0;
    }
    direction.set(
      held("KeyD", "ArrowRight") - held("KeyA", "ArrowLeft") + (touch?.moveX ?? 0),
      held("KeyE") - held("KeyQ") + (touch?.flyY ?? 0),
      held("KeyS", "ArrowDown") - held("KeyW", "ArrowUp") + (touch?.moveZ ?? 0),
    );
    direction.normalize().applyAxisAngle(UP, camera.rotation.y);
    // Joystick deflection ramps from walk speed at the deadzone edge up to sprint at full push,
    // so there's no separate sprint control to fit on screen.
    const touchMag = touch ? Math.min(1, Math.hypot(touch.moveX, touch.moveZ)) : 0;
    const speedMul = held("ShiftLeft", "ShiftRight") ? SPRINT_MULTIPLIER
      : touchMag > 0.05 ? 1 + touchMag * (SPRINT_MULTIPLIER - 1) : 1;
    camera.position.addScaledVector(direction, Math.min(delta, 0.05) * WALK_SPEED * speedMul);
  });
  return null;
}
