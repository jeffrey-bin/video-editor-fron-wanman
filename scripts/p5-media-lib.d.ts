declare module "*.mjs" {
  export const repoRoot: string;
  export const ffmpegBin: () => string;
  export const ffprobeBin: () => string;
  export const run: (bin: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout: Buffer; stderr: string }>;
  export const sha256: (path: string) => Promise<string>;
  export const ffprobeJson: (path: string) => Promise<Record<string, unknown>>;
  export const mediaDurationMs: (probe: Record<string, unknown>) => number;
  export const videoStream: (probe: Record<string, unknown>) => unknown;
  export const audioStream: (probe: Record<string, unknown>) => unknown;
  export const analyzeAudio: (path: string, options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  export const analyzeVideo: (path: string) => Promise<Record<string, unknown>>;
  export const writeJson: (path: string, payload: unknown) => Promise<void>;
  export const loadManifest: (path?: string) => Promise<unknown>;
}
