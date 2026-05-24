export type Locale = "zh-CN" | "ja-JP" | "en-US";

export type MediaKind = "video" | "audio" | "subtitle";
export type TrackRole = "voice" | "music" | "ambient" | "mixed" | "unknown";
export type AnalysisSource = "mock" | "fixture" | "local_analyzer" | "none";
export type TimeRange = { startMs: number; endMs: number; confidence?: number };
export type TranscriptSegment = TimeRange & {
  text: string;
  confidence: number;
  source: "mock" | "fixture" | "local_analyzer" | "imported" | "user";
};
export type AudioEffect =
  | { id: string; type: "reduce_noise"; strength: number; preserveVoice: boolean; noiseProfile: "auto" | "hum" | "wind" | "room"; targetNoiseFloorDbfs?: number }
  | { id: string; type: "equalize_loudness"; targetLufs: number; maxGainDb: number; limitPeakDbfs: number; scopeMode: "clip" | "track" | "selection" }
  | { id: string; type: "duck_music"; voiceTrackId: string; duckDb: number; attackMs: number; releaseMs: number; segments: TimeRange[] }
  | { id: string; type: "mute_range"; startMs: number; endMs: number; rampMs: number; preserveVideo: true }
  | { id: string; type: "audio_fade"; fadeType: "in" | "out" | "cross"; durationMs: number; curve: "linear" | "equal_power" };

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
  audioEffects?: AudioEffect[];
  audioOffsetMs?: number;
  subtitleConfidence?: number;
  subtitleSource?: "user" | "mock_transcript" | "fixture_transcript" | "imported";
  reviewReasonCode?: string;
};

export type Track = {
  id: string;
  kind: ClipKind;
  name: string;
  locked?: boolean;
  muted?: boolean;
  hidden?: boolean;
  role?: TrackRole;
  analysis?: {
    loudnessLufs?: number;
    peakDbfs?: number;
    noiseFloorDbfs?: number;
    speechSegments?: TimeRange[];
    silenceSegments?: TimeRange[];
    transcriptSegments?: TranscriptSegment[];
    avSyncOffsetMs?: number;
    analysisSource: AnalysisSource;
  };
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
