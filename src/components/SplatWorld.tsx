// Renders a World Labs (Marble) Gaussian-splat world with Spark inside react-three-fiber,
// plus its (invisible) collider mesh for raycasting / walking.
import { useEffect, useState } from "react";
import { useThree } from "@react-three/fiber";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { worldTransform } from '../lib/worldTransform';

// Mobile GPUs (and iOS Safari's WebGL memory ceiling in particular) can't carry the same splat
// budget as desktop before the context gets killed outright. Halving it on touch devices trades
// a bit of visual density for actually staying on screen.
const LOD_SPLAT_COUNT = typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)")?.matches ?? false) ? 250_000 : 500_000;

export function SparkSetup({ onError }: { onError?: (message: string) => void }) {
  const { gl, scene } = useThree();
  useEffect(() => {
    const spark = new SparkRenderer({ renderer: gl, lodSplatCount: LOD_SPLAT_COUNT, lodRenderScale: 1.5, maxStdDev: Math.sqrt(5), sortRadial: true });
    scene.add(spark);
    return () => { scene.remove(spark); spark.dispose(); };
  }, [gl, scene]);
  useEffect(() => {
    const canvas = gl.domElement;
    // A context loss (common on iOS under GPU memory pressure with large splat scenes) leaves
    // the canvas permanently black with no other signal — surface it instead of failing silent.
    const lost = (e: Event) => {
      e.preventDefault();
      onError?.("Graphics context was lost, likely from running low on GPU memory for this room. Reload to try again — a smaller capture may render more reliably on this device.");
    };
    canvas.addEventListener("webglcontextlost", lost);
    return () => canvas.removeEventListener("webglcontextlost", lost);
  }, [gl, onError]);
  return null;
}

export function SplatWorld({ url, fileName, metricScale = 1, groundOffset = 0, minRaycastOpacity = 0.2, onReady, onError }: { url: string; fileName?: string; metricScale?: number; groundOffset?: number; minRaycastOpacity?: number; onReady?: () => void; onError?: (message: string) => void }) {
  // Construct inside the effect, not useMemo: React StrictMode mounts, unmounts
  // and remounts in dev. A useMemo'd mesh would be disposed by the first
  // cleanup and then reused dead on remount -> silent black screen.
  const [mesh, setMesh] = useState<SplatMesh | null>(null);
  useEffect(() => {
    // raycastable: lets Spark answer "what splat is under the cursor?" when a world ships
    // without a collider GLB. Approximate, but it keeps placement working.
    // fileName: Convex storage URLs carry no extension. Spark sniffs SPZ/PLY magic
    // bytes fine, but .splat/.ksplat have none — pass the original name so uploads work.
    // lod: the full room is millions of splats; SparkSetup caps the visible budget.
    const m = new SplatMesh({ url, fileName, lod: true, raycastable: true, minRaycastOpacity });
    m.userData.splat = true;
    let alive = true;
    let frame = 0;
    void m.initialized.then(() => {
      if (!alive) return;
      setMesh(m);
      frame = requestAnimationFrame(() => { if (alive) onReady?.(); });
    }).catch((error: unknown) => {
      if (alive) onError?.(error instanceof Error ? error.message : 'Unable to load the room.');
    });
    return () => { alive = false; cancelAnimationFrame(frame); setMesh(null); m.dispose?.(); };
  }, [url, fileName, minRaycastOpacity, onReady, onError]);
  if (!mesh) return null;
  // Marble SPZ is OpenCV (+y down, +z forward) -> flip Y and Z for Three.js; scale to metres.
  return (
    <primitive object={mesh} {...worldTransform(metricScale, groundOffset)} />
  );
}

export function Collider({ url, metricScale = 1, groundOffset = 0, visible = false }: { url: string; metricScale?: number; groundOffset?: number; visible?: boolean }) {
  const { scene } = useGLTF(url);
  useEffect(() => {
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      o.userData.collider = true;
      // Pick surfaces from either side of the exported room mesh.
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        mat.side = THREE.DoubleSide;
        (mat as THREE.MeshStandardMaterial).wireframe = true; // only ever seen via ?debugCollider=1
      }
    });
  }, [scene]);
  return (
    <primitive object={scene} visible={visible} {...worldTransform(metricScale, groundOffset)} />
  );
}
