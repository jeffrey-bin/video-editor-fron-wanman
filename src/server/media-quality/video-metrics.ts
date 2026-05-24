export type FrameMetrics = {
  atPercent: 10 | 50 | 90;
  meanY: number;
  stddevY: number;
  meanSaturation: number;
  variance: number;
  overexposedRatio: number;
  pHash?: string;
};

export type VideoMetrics = {
  durationMs: number;
  width: number;
  height: number;
  frameRate: number;
  sampledFrames: FrameMetrics[];
};

const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const saturation = (r: number, g: number, b: number) => {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  return max === 0 ? 0 : (max - min) / max;
};

export const analyzeRgbFrame = (rgb: Uint8Array, width: number, height: number, atPercent: 10 | 50 | 90): FrameMetrics => {
  const pixels = width * height;
  if (rgb.length < pixels * 3) throw new Error("raw RGB frame is shorter than width*height*3");
  let sumY = 0;
  let sumY2 = 0;
  let sumSaturation = 0;
  let overexposed = 0;
  const hashBits: string[] = [];
  const step = Math.max(1, Math.floor(pixels / 64));
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * 3;
    const y = luminance(rgb[offset], rgb[offset + 1], rgb[offset + 2]);
    sumY += y;
    sumY2 += y * y;
    sumSaturation += saturation(rgb[offset], rgb[offset + 1], rgb[offset + 2]);
    if (y >= 250) overexposed += 1;
    if (pixel % step === 0 && hashBits.length < 64) hashBits.push(y > 127 ? "1" : "0");
  }
  const meanY = sumY / pixels;
  const variance = Math.max(0, sumY2 / pixels - meanY * meanY);
  return {
    atPercent,
    meanY,
    stddevY: Math.sqrt(variance),
    meanSaturation: sumSaturation / pixels,
    variance,
    overexposedRatio: overexposed / pixels,
    pHash: hashBits.join("").padEnd(64, "0"),
  };
};

export const averageFrameMetric = (metrics: VideoMetrics, key: keyof Pick<FrameMetrics, "meanY" | "stddevY" | "meanSaturation" | "variance" | "overexposedRatio">) =>
  metrics.sampledFrames.reduce((sum, frame) => sum + frame[key], 0) / Math.max(1, metrics.sampledFrames.length);
