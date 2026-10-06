// GLB -> printable STL, in the browser.
//
// This used to run in Node (scripts/image-to-stl.mjs convertGlb). The GLB is already
// downloaded and parsed for display here, and STLExporter reads only geometry, so the
// conversion belongs on the client — it keeps three.js out of the Convex bundle and
// costs one extra parse instead of a round trip.
//
// STL carries no color. The GLB stays the canonical coloured asset and is never
// rewritten; this only ever produces a separate derivative.
import { Box3, Group, Vector3 } from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { disposeModel, gltfLoader } from "../components/Asset";

export const PRINT_HEIGHT_MM = 100;

/** Y-up glTF -> Z-up STL, scaled to `heightMm` tall and centred on the print bed. */
export async function glbToStl(url: string, heightMm = PRINT_HEIGHT_MM): Promise<Blob> {
  if (!Number.isFinite(heightMm) || heightMm <= 0) throw new Error("Print height must be positive.");
  const gltf = await gltfLoader.loadAsync(url);
  try {
    // A wrapper carries the axis change so the model's own node transforms survive.
    const orientation = new Group();
    orientation.rotation.x = Math.PI / 2;
    orientation.add(gltf.scene);
    const root = new Group();
    root.add(orientation);
    root.updateMatrixWorld(true);

    const size = new Box3().setFromObject(root).getSize(new Vector3());
    if (!size.toArray().every((n) => Number.isFinite(n) && n > 0)) throw new Error("This model has empty or invalid bounds.");
    root.scale.setScalar(heightMm / size.z);
    root.updateMatrixWorld(true);

    const bounds = new Box3().setFromObject(root);
    root.position.set(-(bounds.min.x + bounds.max.x) / 2, -(bounds.min.y + bounds.max.y) / 2, -bounds.min.z);
    root.updateMatrixWorld(true);

    const view = new STLExporter().parse(root, { binary: true }) as unknown as DataView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const triangles = new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true);
    if (!triangles || bytes.length !== 84 + triangles * 50) throw new Error("The exported STL is malformed.");
    return new Blob([bytes as BlobPart], { type: "model/stl" });
  } finally {
    disposeModel(gltf.scene);
  }
}

declare global { interface Window { ReactNativeWebView?: { postMessage(message: string): void } } }

/** Hand generated geometry to Files/share on iOS or download it in a browser. */
export async function downloadBlob(blob: Blob, filename: string) {
  if (window.ReactNativeWebView) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not prepare the export."));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
    if (dataUrl.length > 40_000_000) throw new Error("This export is too large for the iPhone share sheet (maximum 30 MB).");
    window.ReactNativeWebView.postMessage(JSON.stringify({ version: 1, type: "export", fileName: filename, mimeType: blob.type, dataUrl }));
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const safeFilename = (name: string, fallback = "object") =>
  name.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 60) || fallback;
