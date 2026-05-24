import { describe, expect, it } from "vitest";
import { applyEditOperations, dryRunEditPlan } from "@/server/editor/timeline-ops";
import type { Timeline } from "@/types/editor";

const timeline = (): Timeline => ({
  version: 1,
  durationMs: 10000,
  history: [],
  tracks: [
    { id: "video_main", kind: "video", name: "视频", clips: [{ id: "clip", trackId: "video_main", kind: "video", assetId: "asset", startMs: 0, endMs: 10000, sourceStartMs: 0, sourceEndMs: 10000 }] },
    { id: "audio_main", kind: "audio", name: "音频", clips: [{ id: "audio", trackId: "audio_main", kind: "audio", assetId: "asset_audio", startMs: 0, endMs: 5000, sourceStartMs: 0, sourceEndMs: 5000 }] },
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
    expect(result.timeline.tracks[2].clips[0].text).toBe("你好");
  });

  it("splits and moves clips while preserving invalid operations from mutating original", () => {
    const base = timeline();
    const split = applyEditOperations(base, [
      { id: "split", type: "split_clip", target: { clip_id: "clip", at_ms: 4000 }, params: {}, rationale: "切开" },
      { id: "move", type: "move_clip", target: { clip_id: "clip_split_split" }, params: { start_ms: 4000 }, rationale: "移动" },
    ], { requestId: "req", summary: "split" });
    expect(split.timeline.tracks[0].clips).toHaveLength(2);
    expect(split.timeline.tracks[0].clips[1].startMs).toBe(4000);
    expect(() => dryRunEditPlan(base, [{ id: "bad", type: "add_subtitle", target: {}, params: { start_ms: 9000, end_ms: 12000, text: "bad", locale: "zh-CN" }, rationale: "bad" }])).toThrow();
    expect(base.tracks[2].clips).toHaveLength(0);
  });

  it("rejects move bounds, track kind mismatch, clip kind mismatch and subtitle track mismatch without mutation", () => {
    const base = timeline();
    const before = structuredClone(base);
    expect(() => dryRunEditPlan(base, [{ id: "move-out", type: "move_clip", target: { clip_id: "clip" }, params: { start_ms: 9000 }, rationale: "越界" }])).toThrow("操作超出项目时长");
    expect(() => dryRunEditPlan(base, [{ id: "move-track", type: "move_clip", target: { clip_id: "clip" }, params: { track_id: "subtitles", start_ms: 0 }, rationale: "错轨" }])).toThrow("目标轨道类型");
    expect(() => dryRunEditPlan(base, [{ id: "bad-video", type: "adjust_video", target: { clip_id: "audio" }, params: { brightness: 0.1 }, rationale: "错片段" }])).toThrow("找不到视频片段");
    expect(() => dryRunEditPlan(base, [{ id: "bad-sub", type: "add_subtitle", target: { track_id: "video_main" }, params: { start_ms: 0, end_ms: 1000, text: "字幕", locale: "zh-CN" }, rationale: "错字幕轨" }])).toThrow("目标轨道不是字幕轨");
    expect(base).toEqual(before);
  });

  it("rejects locked track edits and overlapping moves", () => {
    const base = timeline();
    base.tracks[0].locked = true;
    expect(() => dryRunEditPlan(base, [{ id: "trim-locked", type: "trim_clip", target: { clip_id: "clip" }, params: { timeline_start_ms: 100, timeline_end_ms: 900 }, rationale: "锁定轨" }])).toThrow("已锁定");

    const overlap = timeline();
    overlap.tracks[0].clips.push({ id: "clip2", trackId: "video_main", kind: "video", assetId: "asset2", startMs: 6000, endMs: 9000, sourceStartMs: 0, sourceEndMs: 3000 });
    expect(() => dryRunEditPlan(overlap, [{ id: "move-overlap", type: "move_clip", target: { clip_id: "clip2" }, params: { start_ms: 2000 }, rationale: "重叠" }])).toThrow("重叠片段");
  });
});
