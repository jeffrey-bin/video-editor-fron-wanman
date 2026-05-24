"use client";

import { useEffect, useMemo, useState } from "react";
import { Captions, Download, Film, Headphones, Pause, Play, Redo2, Scissors, Send, Settings, Sparkles, Trash2, Undo2, Upload, Wand2, ZoomIn } from "lucide-react";
import type { EditPlanResponse } from "@/server/llm/edit-plan-protocol";
import type { MediaAsset, Project, Timeline } from "@/types/editor";

type JobOutput = { request_id: string; plan: EditPlanResponse; timeline_version: number; plan_state: "ready" | "stale" | "invalid" };
type ProjectPayload = { project: Project; assets: MediaAsset[] };

const mergeAssets = (left: MediaAsset[], right: MediaAsset[]) => {
  const merged = new Map<string, MediaAsset>();
  for (const asset of left) merged.set(asset.id, asset);
  for (const asset of right) merged.set(asset.id, asset);
  return [...merged.values()];
};

const ms = (value: number) => {
  const total = Math.floor(value / 1000);
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  const millis = String(Math.floor((value % 1000) / 10)).padStart(2, "0");
  return `00:${minutes}:${seconds}:${millis}`;
};

const clipStyle = (start: number, end: number, duration: number) => ({
  left: `${Math.max(0, (start / duration) * 100)}%`,
  width: `${Math.max(6, ((end - start) / duration) * 100)}%`,
});

export function EditorShell() {
  const [project, setProject] = useState<Project | null>(null);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [prompt, setPrompt] = useState("剪掉开头 3 秒的空白，增强人声并让画面更明亮、肤色更自然，添加字幕并优化断句");
  const [plan, setPlan] = useState<JobOutput | null>(null);
  const [running, setRunning] = useState(false);
  const [exportJob, setExportJob] = useState<{ job_id: string; progress: number; path?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/projects")
      .then((res) => res.json())
      .then((data) => {
        setProject(data.project);
        setAssets(data.assets);
      });
  }, []);

  const duration = project?.timeline.durationMs ?? 24200;
  const caption = useMemo(() => {
    const subtitle = project?.timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.kind === "subtitle" && clip.text);
    return subtitle?.text ?? "导入素材后开始 Prompt 编辑";
  }, [project]);

  const handleImport = async (file?: File) => {
    if (!file) return;
    setError(null);
    try {
      const activeState = project ? { project, assets } : await fetch("/api/projects").then(async (res) => {
        if (!res.ok) throw new Error("项目初始化失败");
        return (await res.json()) as ProjectPayload;
      });
      setProject(activeState.project);
      setAssets(activeState.assets);
      const body = new FormData();
      body.append("projectId", activeState.project.id);
      body.append("file", file);
      const importResponse = await fetch("/api/assets", { method: "POST", body });
      const data = await importResponse.json();
      if (!importResponse.ok || !data.asset) {
        setError(data.error?.message ?? "素材导入失败");
        return;
      }
      const uploadedAsset = data.asset as MediaAsset;
      setAssets((current) => mergeAssets(current, [uploadedAsset]));
      const latestResponse = await fetch("/api/projects");
      if (!latestResponse.ok) {
        setAssets((current) => mergeAssets(current, [uploadedAsset]));
        return;
      }
      const latest = (await latestResponse.json()) as ProjectPayload;
      setProject(latest.project);
      setAssets((current) => mergeAssets(current, latest.assets));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "素材导入失败");
    }
  };

  const runPrompt = async () => {
    if (!project || assets.length === 0) return;
    setRunning(true);
    setError(null);
    setPlan(null);
    try {
      const request = await fetch("/api/prompt-edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: project.id,
          timeline_version: project.timeline.version,
          prompt,
          locale: "zh-CN",
          scope: { type: "timeline", start_ms: 0, end_ms: project.timeline.durationMs },
        }),
      }).then((res) => res.json());
      const job = await fetch(`/api/jobs/${request.job_id}`).then((res) => res.json());
      if (job.job.status === "failed") {
        setError(job.job.error?.message ?? "Prompt 方案生成失败");
        return;
      }
      setPlan(job.job.output);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Prompt 生成失败");
    } finally {
      setRunning(false);
    }
  };

  const applyPlan = async () => {
    if (!project || !plan) return;
    const response = await fetch(`/api/projects/${project.id}/apply-edit-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: plan.request_id,
        timeline_version: plan.timeline_version,
        operation_ids: plan.plan.operations.map((operation) => operation.id),
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error?.message ?? "应用方案失败");
      return;
    }
    setProject((current) => (current ? { ...current, timeline: data.timeline } : current));
    setPlan(null);
  };

  const exportTimeline = async () => {
    if (!project) return;
    const response = await fetch("/api/exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: project.id, preset: "1080p_landscape", timeline_version: project.timeline.version, ignorePendingPlan: !plan }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error?.message ?? "导出失败");
      return;
    }
    const job = await fetch(`/api/jobs/${data.job_id}`).then((res) => res.json());
    setExportJob({ job_id: data.job_id, progress: job.job.progress, path: job.job.output.export_path });
  };

  const renderTracks = (timeline: Timeline) =>
    timeline.tracks.map((track) => (
      <div key={track.id} className={`track ${track.kind === "subtitle" ? "caption" : ""} ${track.kind === "ai" ? "ai" : ""}`}>
        <div className="track-label">{track.name}</div>
        <div className="lane">
          {track.kind === "ai" && plan ? (
            <div className="clip" style={clipStyle(0, Math.min(3000, duration), duration)}>AI 剪切点</div>
          ) : null}
          {track.clips.map((clip) => (
            <div key={clip.id} className={`clip ${clip.kind}`} style={clipStyle(clip.startMs, clip.endMs, duration)}>
              {clip.text ?? (clip.kind === "video" ? "湖边风景" : clip.kind === "audio" ? "人声增强" : "片段")}
            </div>
          ))}
        </div>
      </div>
    ));

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">PromptCut Studio</div>
        <div className="toolbar">
          <span className="project-title">{project?.name ?? "旅行 vlog 片段"} · 已保存 <span className="dot" /></span>
          <div className="tool-group">
            <button className="icon-button" title="撤销"><Undo2 size={16} /></button>
            <button className="icon-button" title="重做"><Redo2 size={16} /></button>
            <button className="icon-button" title="分割"><Scissors size={16} /></button>
            <button className="icon-button" title="字幕"><Captions size={16} /></button>
            <button className="icon-button" title="音频增强"><Headphones size={16} /></button>
          </div>
        </div>
        <div className="actions">
          <button className="icon-button" title="设置"><Settings size={16} /></button>
          <button data-testid="export-timeline" className="primary-button" onClick={exportTimeline}><Download size={16} />导出</button>
        </div>
      </header>

      <aside className="panel left-panel">
        <div className="panel-header"><span>导入素材</span><Upload size={16} /></div>
        <label className="import-card">
          <input data-testid="file-input" type="file" accept="video/*,audio/*,.srt" onChange={(event) => handleImport(event.target.files?.[0])} />
          <span><Upload size={30} style={{ margin: "0 auto 8px" }} />拖拽文件到此处导入<br /><b>或点击浏览文件</b><br /><small>支持视频、音频、图片、字幕（SRT）</small></span>
        </label>
        <div className="panel-header"><span>媒体库</span><Film size={16} /></div>
        <div className="media-list">
          {assets.length === 0 ? <div className="muted">拖入视频、音频或字幕开始编辑</div> : null}
          {assets.map((asset) => (
            <div className="media-item" key={asset.id}>
              <div className="thumb" data-duration={ms(asset.durationMs).slice(3, 8)} />
              <div>
                <div className="media-name">{asset.originalName}</div>
                <div className="muted">{asset.kind} · {asset.width ?? "-"}x{asset.height ?? "-"} · {(asset.durationMs / 1000).toFixed(1)}s</div>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <section className="panel preview-panel">
        <div className="panel-header"><span>预览</span><span className="muted">适合</span></div>
        <div className="preview-stage">
          <div className="safe-frame" />
          <div className="preview-caption">{caption}</div>
        </div>
        <div className="player-controls">
          <span className="timecode">00:00:05:12</span>
          <button className="icon-button"><Pause size={16} /></button>
          <button className="icon-button"><Play size={16} /></button>
          <span className="muted">{ms(duration)}</span>
        </div>
      </section>

      <section className="panel timeline-panel">
        <div className="panel-header"><span>时间线</span><span className="muted">版本 {project?.timeline.version ?? 1}</span></div>
        <div className="timeline-tools">
          <button className="icon-button"><Wand2 size={16} /></button>
          <button className="icon-button"><Trash2 size={16} /></button>
          <button className="icon-button"><ZoomIn size={16} /></button>
          <span className="muted">吸附开启 · 非破坏编辑</span>
        </div>
        <div className="timeline-ruler"><span>00:00:00</span><span>00:00:05</span><span>00:00:10</span><span>00:00:15</span><span>00:00:20</span><span>00:00:25</span></div>
        <div className="tracks"><div className="playhead" />{project ? renderTracks(project.timeline) : null}</div>
      </section>

      <aside className="panel prompt-panel">
        <div className="tabs"><button className="tab active">剪辑</button><button className="tab">修改 / 润色</button><button className="tab">历史</button><button className="tab">导出</button></div>
        <div className="prompt-body">
          <textarea className="prompt-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="用自然语言描述你想要的编辑操作..." />
          <div className="chips">
            {["剪掉开头 3 秒的空白", "增强人声并降低背景噪声", "让画面更明亮、肤色更自然", "添加字幕并优化断句"].map((item) => (
              <button key={item} className="chip" onClick={() => setPrompt(item)}>{item}</button>
            ))}
          </div>
          <button data-testid="run-prompt" className="primary-button" disabled={assets.length === 0 || running} onClick={runPrompt}><Send size={16} />生成待确认方案</button>
        </div>
        <div className="section">
          <div className="llm-card">
            <b>LLM 状态</b>
            <span><span className="dot" />Local LLM Provider · {running ? "生成方案中" : "待生成方案"}</span>
            <div className="progress"><span style={{ width: running ? "72%" : "100%" }} /></div>
            <pre className="log">{`$ codex exec --model gpt-5.3-codex --json
analyzing timeline...
${plan ? "review plan ready" : running ? "generating reviewable edit plan..." : "provider selected by LLM_PROVIDER"}`}</pre>
          </div>
        </div>
        {error ? <div className="section"><div className="error-card">错误重试：{error}</div></div> : null}
        {plan ? (
          <div className="section">
            <div className="result-card" data-testid="edit-plan">
              <b><Sparkles size={16} /> 方案审阅</b>
              <span>{plan.plan.summary}</span>
              <span className="muted">置信度 {(plan.plan.confidence * 100).toFixed(0)}% · {plan.plan_state}</span>
              <ul className="result-list">{plan.plan.operations.map((operation) => <li key={operation.id}>{operation.type}：{operation.rationale}</li>)}</ul>
              <button data-testid="apply-plan" className="primary-button" onClick={applyPlan}>应用到时间线</button>
            </div>
          </div>
        ) : null}
        <div className="section">
          <div className="export-card" data-testid="export-card">
            <b>导出队列</b>
            <span>1080p MP4</span>
            <div className="progress"><span style={{ width: `${exportJob?.progress ?? 0}%` }} /></div>
            <span className="muted">{exportJob ? `已完成：${exportJob.path}` : "等待导出任务"}</span>
          </div>
        </div>
      </aside>

      <footer className="statusbar"><span>24fps · 48kHz · 代理媒体就绪</span><span>后台任务：{running ? "LLM 处理中" : exportJob ? "导出完成" : "空闲"}</span></footer>
    </main>
  );
}
