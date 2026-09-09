/** Shared domain types for doodleforge. Match HACKATHON_PLAN.md record names. */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
/** Column-major 4×4 matrix as 16 numbers. */
export type Mat4 = number[];

export type AppError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type WorldCoordinates = {
  splatToApp: Mat4 | null;
  colliderToApp: Mat4 | null;
  worldTransformVersion: number;
  calibration: string;
  colliderAlignment: string;
  metricMetadataAvailable: boolean;
};

export type WorldView = {
  worldId: string;
  displayName: string;
  preferredSplat: string;
  coordinates: WorldCoordinates;
};

export type SceneObject = {
  id: string;
  objectAssetId: string;
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
  confirmedDimensions: null;
  revision: number;
};

export type ProjectView = {
  id: string;
  backendMode: 'local';
  activeWorldId: string;
  sceneRevision: number;
  world: WorldView;
  objects: SceneObject[];
  activeJob: null;
};

export type WorldAssets = {
  splatUrl: string;
  colliderUrl: string;
  thumbnailUrl: string | null;
};

export type AssetQuality = 'laptop' | 'phone';
