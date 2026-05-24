import { describe, expect, it } from "vitest";
import { EditOperationSchema } from "@/server/editor/operation-schema";

describe("EditOperationSchema", () => {
  it("accepts all P0 operation families", () => {
    const samples = [
      { id: "1", type: "trim_clip", target: { clip_id: "clip" }, params: { timeline_start_ms: 1, timeline_end_ms: 2 }, rationale: "trim" },
      { id: "2", type: "delete_range", target: { start_ms: 0, end_ms: 2 }, params: { ripple: true }, rationale: "delete" },
      { id: "3", type: "move_clip", target: { clip_id: "clip" }, params: { start_ms: 4 }, rationale: "move" },
      { id: "4", type: "split_clip", target: { clip_id: "clip", at_ms: 5 }, params: {}, rationale: "split" },
      { id: "5", type: "add_subtitle", target: {}, params: { start_ms: 1, end_ms: 2, text: "字幕" }, rationale: "subtitle" },
      { id: "6", type: "update_subtitle", target: { subtitle_id: "sub" }, params: { text: "改" }, rationale: "update" },
      { id: "7", type: "adjust_video", target: { clip_id: "clip" }, params: { brightness: 0.1 }, rationale: "video" },
      { id: "8", type: "adjust_audio", target: { clip_id: "clip" }, params: { normalize: true }, rationale: "audio" },
      { id: "9", type: "set_export_preset", target: { project_id: "project" }, params: { preset: "1080p_landscape" }, rationale: "export" },
    ];
    for (const sample of samples) expect(EditOperationSchema.safeParse(sample).success).toBe(true);
  });

  it("rejects invalid time ranges and unknown operations", () => {
    expect(EditOperationSchema.safeParse({ id: "bad", type: "delete_range", target: { start_ms: 5, end_ms: 1 }, params: {}, rationale: "bad" }).success).toBe(false);
    expect(EditOperationSchema.safeParse({ id: "bad", type: "replace_person", target: {}, params: {}, rationale: "bad" }).success).toBe(false);
  });
});
