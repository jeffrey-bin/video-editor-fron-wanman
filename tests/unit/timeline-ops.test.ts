import { describe, expect, it } from "vitest";
import { applyEditOperations, dryRunEditPlan } from "@/server/editor/timeline-ops";
import type { Timeline } from "@/types/editor";

const timeline = (): Timeline => ({
  version: 1,
  durationMs: 10000,
  history: [],
  tracks: [
    { id: "video_main", kind: "video", name: "视频", clips: [{ id: "clip", trackId: "video_main", kind: "video", assetId: "asset", startMs: 0, endMs: 10000, sourceStartMs: 0, sourceEndMs: 10000 }] },
    { id: "subtitles", kind: "subtitle", name: "字幕", clips: [] },
  ],
});

describe("timeline ops", () => {
  it("applies delete, adjust and subtitle operations non-destructively", () => {
    const base = timeline();
    const result = applyEditOperations(base, [
      { id: "delete", type: "delete_range", target: { start_ms: 0, end_ms: 3000 }, params: { ripple: true }, rationale: "删开头" },
      { id: "video", type: "adjust_video", target: { clip_id: "clip" }, params: { brightness: 0.1 }, rationale: "提亮" },
      { id: "sub", type: "add_subtitle", target: {}, params: { start_ms: 1000, end_ms: 2000, text: "你好", locale: "zh-CN" }, rationale: "字幕" },
    ], { requestId: "req", summary: "AI 编辑" });
    expect(base.version).toBe(1);
    expect(result.timeline.version).toBe(2);
    expect(result.timeline.durationMs).toBe(7000);
    expect(result.timeline.tracks[0].clips[0].filters?.brightness).toBe(0.1);
    expect(result.timeline.tracks[1].clips[0].text).toBe("你好");
  });

  it("splits and moves clips while preserving invalid operations from mutating original", () => {
    const base = timeline();
    const split = applyEditOperations(base, [
      { id: "split", type: "split_clip", target: { clip_id: "clip", at_ms: 4000 }, params: {}, rationale: "切开" },
      { id: "move", type: "move_clip", target: { clip_id: "clip_split_split" }, params: { start_ms: 6000 }, rationale: "移动" },
    ], { requestId: "req", summary: "split" });
    expect(split.timeline.tracks[0].clips).toHaveLength(2);
    expect(split.timeline.tracks[0].clips[1].startMs).toBe(6000);
    expect(() => dryRunEditPlan(base, [{ id: "bad", type: "add_subtitle", target: {}, params: { start_ms: 9000, end_ms: 12000, text: "bad", locale: "zh-CN" }, rationale: "bad" }])).toThrow();
    expect(base.tracks[1].clips).toHaveLength(0);
  });
});
