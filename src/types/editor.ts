export type Locale = "zh-CN" | "ja-JP" | "en-US";

export type MediaKind = "video" | "audio" | "subtitle";

export type MediaAsset = {
  id: string;
  projectId: string;
  kind: MediaKind;
  originalName: string;
  mimeType: string;
  sizeBytes?: number;
  sha256?: string;
  originalKey?: string;
  proxyKey?: string;
  thumbnailKey?: string;
  waveformKey?: string;
  probeStatus?: "pending" | "succeeded" | "failed";
  probeError?: string;
  durationMs: number;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  filePath?: string;
  thumbnailUrl?: string;
};

export type ClipKind = "video" | "audio" | "subtitle" | "ai";

export type Clip = {
  id: string;
  trackId: string;
  assetId?: string;
  kind: ClipKind;
  startMs: number;
  endMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  text?: string;
  muted?: boolean;
  volumeDb?: number;
  filters?: {
    brightness?: number;
    contrast?: number;
    saturation?: number;
    normalize?: boolean;
  };
};

export type Track = {
  id: string;
  kind: ClipKind;
  name: string;
  locked?: boolean;
  muted?: boolean;
  hidden?: boolean;
  clips: Clip[];
};

export type Timeline = {
  version: number;
  durationMs: number;
  tracks: Track[];
  history: TimelineHistoryEntry[];
};

export type TimelineHistoryEntry = {
  id: string;
  requestId: string;
  summary: string;
  operationIds: string[];
  createdAt: string;
};

export type Project = {
  id: string;
  name: string;
  locale: Locale;
  timeline: Timeline;
  exportPreset: ExportPreset;
  storageRoot?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ExportPreset = "source" | "1080p_landscape" | "1080p_portrait" | "720p_preview";
