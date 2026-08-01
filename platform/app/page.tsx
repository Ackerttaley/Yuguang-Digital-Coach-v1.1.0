"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

const API = "http://127.0.0.1:8000";

type VideoItem = {
  id: string;
  name: string;
  display_name: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  size: number;
  file_fingerprint: string;
  latest_analysis_id?: string | null;
};

type HubSection =
  | "home"
  | "training"
  | "analysis"
  | "twin"
  | "reports"
  | "models";
type SessionStatus =
  | "idle"
  | "loading"
  | "queued"
  | "running"
  | "ready"
  | "failed";

type ActiveSession = {
  video_id: string | null;
  calibration_id: string | null;
  job_id: string | null;
  analysis_id: string | null;
  player_side: "near" | "far";
  status: SessionStatus;
  source: "computed" | "cache" | null;
  segment_start: number;
  segment_end: number | null;
  error: string | null;
};

type AdviceItem = {
  title: string;
  observation: string;
  action: string;
  evidence_time: number;
  confidence: number;
  metric: string;
  operator: string;
  threshold: number | null;
  evidence: Record<string, number>;
  recommendation: string;
  rule_version: string;
  source: string;
  knowledge_source?: string;
};

type Analysis = {
  id: string;
  analysis_id: string;
  video_id: string;
  video: VideoItem;
  player_side: "near" | "far";
  calibration_id: string | null;
  calibration_version: number;
  tracks: { t: number; x: number; y: number; confidence: number }[];
  heatmap: number[][];
  metrics: Record<string, number>;
  advice: AdviceItem[];
  quality: {
    label: string;
    confidence: number;
    note: string;
    sampled_frames: number;
    accepted_frames: number;
    average_confidence: number;
    failure_reason: string | null;
  };
  segment: { start: number; end: number; duration: number };
  source: "computed" | "cache" | "template";
  model_version: string;
  rule_version: string;
  schema_version: string;
  created_at: number;
};

type PosePoint = {
  id: number;
  x: number;
  y: number;
  z: number;
  visibility: number;
};

type PoseFrame = {
  t: number;
  confidence: number;
  bbox: { x: number; y: number; w: number; h: number };
  landmarks: PosePoint[];
};

type PosePayload = {
  video_id: string;
  model: string;
  model_version: string;
  start: number;
  end: number;
  sample_fps: number;
  frames: PoseFrame[];
  sampled_frames: number;
  accepted_frames: number;
  average_confidence: number;
  failure_reason: string | null;
  source: "computed" | "cache";
  confidence_threshold: number;
  shuttle_tracking: { enabled: false; reason: string };
};

type HealthPayload = {
  status: string;
  service_version: string;
  pose_available: boolean;
  pose_error: string | null;
  resource_dir: string | null;
  gpu_available: boolean;
  gpu_name: string | null;
  model_version: string;
  rule_version: string;
  schema_version: string;
  shuttle_tracking_enabled: false;
};

type JobPayload = {
  id: string;
  video_id: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  message: string;
  analysis_id?: string | null;
  source: "computed" | "cache";
  error?: string | null;
};

const emptySession: ActiveSession = {
  video_id: null,
  calibration_id: null,
  job_id: null,
  analysis_id: null,
  player_side: "near",
  status: "idle",
  source: null,
  segment_start: 0,
  segment_end: null,
  error: null,
};

const calibrationPreset = [
  [0.18, 0.88],
  [0.82, 0.88],
  [0.62, 0.22],
  [0.38, 0.22],
];
const pointLabels = ["近场左角", "近场右角", "远场右角", "远场左角"];
const poseConnections = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
  [27, 29],
  [29, 31],
  [28, 30],
  [30, 32],
];
const POSE_WINDOW_SECONDS = 20;
const POSE_WINDOW_DURATION = 30;
const MIN_ANALYSIS_SEGMENT_SECONDS = 5;
const MAX_ANALYSIS_SEGMENT_SECONDS = 30 * 60;

function timeLabel(value: number, withFraction = false) {
  if (!Number.isFinite(value) || value < 0) return "—";
  const minute = Math.floor(value / 60);
  const seconds = withFraction
    ? (value % 60).toFixed(2).padStart(5, "0")
    : String(Math.floor(value % 60)).padStart(2, "0");
  return `${minute}:${seconds}`;
}

function metricLabel(value: number | undefined, digits = 0) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : "—";
}

function normalizeSegment(
  videoDuration: number,
  requestedStart: number,
  requestedEnd: number | null,
) {
  const safeDuration = Math.max(0, videoDuration);
  const maxStart = Math.max(0, safeDuration - MIN_ANALYSIS_SEGMENT_SECONDS);
  const start = Math.min(Math.max(0, requestedStart), maxStart);
  const latestEnd = Math.min(
    safeDuration,
    start + MAX_ANALYSIS_SEGMENT_SECONDS,
  );
  const earliestEnd = Math.min(
    safeDuration,
    start + MIN_ANALYSIS_SEGMENT_SECONDS,
  );
  const end = Math.min(
    latestEnd,
    Math.max(earliestEnd, requestedEnd ?? latestEnd),
  );
  return { start, end };
}

function caseName(video: VideoItem, index = 0) {
  if (video.display_name) return video.display_name;
  return `单打训练案例 ${video.id.slice(0, 4).toUpperCase() || index + 1}`;
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const payload = await response.json();
      const detail = payload?.detail;
      message =
        typeof detail === "string" ? detail : detail?.message ?? message;
    } catch {
      // 响应不是 JSON 时，保留根据状态生成的提示信息。
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function Shuttle() {
  return (
    <span className="shuttle">
      <i />
      <b />
    </span>
  );
}

function VideoImportButton({
  busy,
  disabled,
  onImport,
  variant = "solid",
}: {
  busy: boolean;
  disabled?: boolean;
  onImport: (file: File) => Promise<void>;
  variant?: "solid" | "outline";
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <span className="video-import">
      <input
        ref={input}
        type="file"
        accept="video/mp4,.mp4"
        aria-label="选择本地 MP4 视频"
        disabled={busy || disabled}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void onImport(file);
        }}
      />
      <button
        className={variant === "solid" ? "solid-btn" : "outline-btn"}
        type="button"
        disabled={busy || disabled}
        onClick={() => input.current?.click()}
      >
        {busy ? "正在导入…" : "＋ 选择视频"}
      </button>
    </span>
  );
}

function VideoSegmentSelector({
  video,
  initialStart,
  initialEnd,
  onCancel,
  onConfirm,
}: {
  video: VideoItem;
  initialStart: number;
  initialEnd: number | null;
  onCancel: () => void;
  onConfirm: (start: number, end: number) => void;
}) {
  const player = useRef<HTMLVideoElement>(null);
  const initialDuration = Math.max(0, video.duration || 0);
  const initialSegment = normalizeSegment(
    initialDuration,
    initialStart,
    initialEnd,
  );
  const [duration, setDuration] = useState(initialDuration);
  const [currentTime, setCurrentTime] = useState(initialSegment.start);
  const [segmentStart, setSegmentStart] = useState(initialSegment.start);
  const [segmentEnd, setSegmentEnd] = useState(initialSegment.end);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onCancel]);

  function seek(value: number) {
    const next = Math.max(0, Math.min(value, duration));
    if (player.current) player.current.currentTime = next;
    setCurrentTime(next);
  }

  function startPreview() {
    if (!player.current) return;
    player.current.currentTime = segmentStart;
    setCurrentTime(segmentStart);
    void player.current.play();
  }

  const segmentDuration = Math.max(0, segmentEnd - segmentStart);
  const canConfirm =
    duration >= MIN_ANALYSIS_SEGMENT_SECONDS &&
    segmentDuration >= MIN_ANALYSIS_SEGMENT_SECONDS &&
    segmentDuration <= MAX_ANALYSIS_SEGMENT_SECONDS;
  const startPercent =
    (segmentStart / Math.max(duration, 0.001)) * 100;
  const endPercent = (segmentEnd / Math.max(duration, 0.001)) * 100;
  const rangeStyle = {
    "--segment-start": `${Math.max(0, Math.min(100, startPercent))}%`,
    "--segment-end": `${Math.max(0, Math.min(100, endPercent))}%`,
  } as CSSProperties;
  const validationMessage =
    duration < MIN_ANALYSIS_SEGMENT_SECONDS
      ? "视频不足 5 秒，无法生成分析。"
      : segmentDuration < MIN_ANALYSIS_SEGMENT_SECONDS
        ? "分析片段不能短于 5 秒。"
        : segmentDuration > MAX_ANALYSIS_SEGMENT_SECONDS
          ? "分析片段不能超过 30 分钟。"
          : "确认后，后续姿态、跑位和报告仅使用这一时间段。";

  return (
    <div className="segment-modal" role="dialog" aria-modal="true">
      <div className="segment-dialog">
        <header>
          <div>
            <span className="section-label">VIDEO PREVIEW</span>
            <h2>预览并选择分析区间</h2>
          </div>
          <button
            className="segment-close"
            type="button"
            onClick={onCancel}
            aria-label="关闭区间选择"
          >
            ×
          </button>
        </header>

        <div className="segment-layout">
          <div className="segment-preview">
            <video
              ref={player}
              src={`${API}/api/videos/${video.id}/stream`}
              controls
              playsInline
              onLoadedMetadata={(event) => {
                const actualDuration =
                  event.currentTarget.duration || video.duration || 0;
                const normalized = normalizeSegment(
                  actualDuration,
                  segmentStart,
                  initialEnd === null ? null : segmentEnd,
                );
                setDuration(actualDuration);
                setSegmentStart(normalized.start);
                setSegmentEnd(normalized.end);
                event.currentTarget.currentTime = normalized.start;
                setCurrentTime(normalized.start);
              }}
              onTimeUpdate={(event) => {
                const next = event.currentTarget.currentTime;
                setCurrentTime(next);
                if (!event.currentTarget.paused && next >= segmentEnd) {
                  event.currentTarget.pause();
                  event.currentTarget.currentTime = segmentEnd;
                  setCurrentTime(segmentEnd);
                }
              }}
            />
            <span>
              当前时间 {timeLabel(currentTime, true)} /{" "}
              {timeLabel(duration, true)}
            </span>
          </div>

          <aside className="segment-editor">
            <div className="segment-range-control">
              <div className="segment-range-endpoints">
                <span>
                  <small>开始时间</small>
                  <b>{timeLabel(segmentStart, true)}</b>
                </span>
                <span>
                  <small>结束时间</small>
                  <b>{timeLabel(segmentEnd, true)}</b>
                </span>
              </div>
              <div className="dual-range" style={rangeStyle}>
                <div className="dual-range-track" aria-hidden="true">
                  <i />
                </div>
                <input
                  className="dual-range-start"
                  aria-label="分析开始时间"
                  aria-valuetext={timeLabel(segmentStart, true)}
                  type="range"
                  min="0"
                  max={duration}
                  step=".1"
                  value={segmentStart}
                  onChange={(event) => {
                    const minimum = Math.max(
                      0,
                      segmentEnd - MAX_ANALYSIS_SEGMENT_SECONDS,
                    );
                    const maximum = Math.max(
                      0,
                      segmentEnd - MIN_ANALYSIS_SEGMENT_SECONDS,
                    );
                    const value = Math.min(
                      maximum,
                      Math.max(minimum, Number(event.target.value)),
                    );
                    setSegmentStart(value);
                    seek(value);
                  }}
                />
                <input
                  className="dual-range-end"
                  aria-label="分析结束时间"
                  aria-valuetext={timeLabel(segmentEnd, true)}
                  type="range"
                  min="0"
                  max={duration}
                  step=".1"
                  value={segmentEnd}
                  onChange={(event) => {
                    const minimum = Math.min(
                      duration,
                      segmentStart + MIN_ANALYSIS_SEGMENT_SECONDS,
                    );
                    const maximum = Math.min(
                      duration,
                      segmentStart + MAX_ANALYSIS_SEGMENT_SECONDS,
                    );
                    const value = Math.max(
                      minimum,
                      Math.min(maximum, Number(event.target.value)),
                    );
                    setSegmentEnd(value);
                    seek(value);
                  }}
                />
              </div>
              <div className="segment-range-limits">
                <span>最短 5 秒</span>
                <span>最长 30 分钟</span>
              </div>
              <p className="segment-camera-tip">
                选择的片段最好是同一机位哦！
              </p>
            </div>

            <div className="segment-markers">
              <button
                type="button"
                onClick={() => {
                  const minimum = Math.max(
                    0,
                    segmentEnd - MAX_ANALYSIS_SEGMENT_SECONDS,
                  );
                  const maximum = Math.max(
                    0,
                    segmentEnd - MIN_ANALYSIS_SEGMENT_SECONDS,
                  );
                  const value = Math.min(
                    maximum,
                    Math.max(minimum, currentTime),
                  );
                  setSegmentStart(value);
                }}
              >
                当前画面设为开始
              </button>
              <button
                type="button"
                onClick={() => {
                  const minimum = Math.min(
                    duration,
                    segmentStart + MIN_ANALYSIS_SEGMENT_SECONDS,
                  );
                  const maximum = Math.min(
                    duration,
                    segmentStart + MAX_ANALYSIS_SEGMENT_SECONDS,
                  );
                  const value = Math.max(
                    minimum,
                    Math.min(maximum, currentTime),
                  );
                  setSegmentEnd(value);
                }}
              >
                当前画面设为结束
              </button>
            </div>

            <button
              className="segment-play"
              type="button"
              onClick={startPreview}
            >
              ▶ 播放所选区间
            </button>
          </aside>
        </div>

        <footer>
          <span>{validationMessage}</span>
          <div>
            <button className="outline-btn" type="button" onClick={onCancel}>
              取消
            </button>
            <button
              className="solid-btn"
              type="button"
              disabled={!canConfirm}
              onClick={() => onConfirm(segmentStart, segmentEnd)}
            >
              确认区间并进入分析
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function VideoRenameDialog({
  video,
  busy,
  error,
  onCancel,
  onRename,
}: {
  video: VideoItem;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onRename: (displayName: string) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(caseName(video));
  const trimmedName = displayName.trim();

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [busy, onCancel]);

  return (
    <div className="rename-modal" role="dialog" aria-modal="true">
      <form
        className="rename-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedName && !busy) void onRename(trimmedName);
        }}
      >
        <header>
          <div>
            <span className="section-label">VIDEO NAME</span>
            <h2>重命名训练视频</h2>
            <p>名称会保存在本机，不会改变原视频文件和已有分析结果。</p>
          </div>
          <button
            className="segment-close"
            type="button"
            disabled={busy}
            onClick={onCancel}
            aria-label="关闭重命名窗口"
          >
            ×
          </button>
        </header>
        <label>
          <span>视频名称</span>
          <input
            autoFocus
            type="text"
            maxLength={80}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "rename-error" : undefined}
          />
        </label>
        {error && (
          <p className="rename-error" id="rename-error">
            {error}
          </p>
        )}
        <footer>
          <button
            className="outline-btn"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="solid-btn"
            type="submit"
            disabled={!trimmedName || busy}
          >
            {busy ? "正在保存…" : "保存名称"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Landing({
  videos,
  connection,
  importing,
  importMessage,
  importError,
  onRetry,
  onImport,
  onOpen,
  onEnter,
}: {
  videos: VideoItem[];
  connection: "loading" | "online" | "offline";
  importing: boolean;
  importMessage: string | null;
  importError: string | null;
  onRetry: () => void;
  onImport: (file: File) => Promise<void>;
  onOpen: (video: VideoItem) => void;
  onEnter: () => void;
}) {
  return (
    <main className="landing">
      <header className="top-nav">
        <button
          className="brand"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          <span>
            <Shuttle />
          </span>
          <strong>羽光智教</strong>
        </button>
        <span className="team-byline">暨南大学“羽光智教”团队出品</span>
        <nav>
          <a href="#home">首页</a>
          <a href="#advantages">智能分析</a>
          <a href="#cases">训练案例</a>
        </nav>
        <button className="primary-pill" onClick={onEnter}>
          进入平台 ↗
        </button>
      </header>

      <section className="hero" id="home">
        <div className="hero-title">
          <span className="eyebrow">
            <i /> LOCAL BADMINTON INTELLIGENCE <i />
          </span>
          <h1>
            让每一次挥拍，<em>都有答案</em>
          </h1>
          <p>基于本地视频证据的羽毛球 2.5D 训练数据回放与教练辅助平台</p>
        </div>
        <div
          className="hero-motion hero-animation"
          aria-label="羽毛球训练能力界面示意"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="hero-photo"
            src="/badminton-sunset-hero.png"
            alt="运动员在夕阳下进行羽毛球训练"
          />
          <div className="animated-court" aria-hidden="true">
            <i className="court-line court-center" />
            <i className="court-line court-service-a" />
            <i className="court-line court-service-b" />
          </div>
          <div className="hero-athlete" aria-hidden="true">
            <span className="hero-head" />
            <span className="hero-torso">
              <b>YG</b>
            </span>
            <i className="hero-limb arm-smash" />
            <i className="hero-limb leg-front" />
            <span className="hero-racket" />
          </div>
          <div className="glass-chip signal-chip">
            <span className="bars">
              <i />
              <i />
              <i />
            </span>
            <div>
              <strong>真实姿态 · 跑位证据</strong>
              <small>动画仅作能力示意</small>
            </div>
          </div>
          <div className="glass-chip confidence-chip">
            <span className="score">2.5D</span>
            <div>
              <strong>训练数据回放</strong>
              <small>研发预览</small>
            </div>
          </div>
        </div>
      </section>

      <section className="intro" id="advantages">
        <span className="section-label">WHY YUGUANG</span>
        <h2>
          从训练视频中，<em>看见动作与跑位</em>
        </h2>
        <p>
          面向羽毛球单打训练，提供姿态分析、场区跑位回放与训练报告，帮助教练和学员高效复盘每一次训练。
        </p>
      </section>

      <section className="story pose-story">
        <span className="story-index">01</span>
        <div className="story-copy">
          <span className="section-label">TRACEABLE ANALYSIS</span>
          <h3>视频姿态与跑位分析</h3>
          <p>
            从训练视频中识别人体关键点与场区移动信息，将动作片段、跑位轨迹和训练建议集中呈现。
          </p>
          <div className="story-facts">
            <span>
              <b>33</b>人体关键点
            </span>
            <span>
              <b>LOCAL</b>本机处理
            </span>
            <span>
              <b>0</b>网络上传
            </span>
          </div>
        </div>
        <div className="pose-art">
          {/* Vinext 本地模式不提供稳定的图像优化路由。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/young-badminton-pexels.jpg"
            alt="青年学生在室内进行羽毛球训练"
          />
          <div className="pose-photo-shade" />
        </div>
      </section>

      <section className="cases" id="cases">
        <header>
          <div>
            <span className="section-label">LOCAL CASE LIBRARY</span>
            <h2>选择训练视频</h2>
          </div>
          <div className="case-actions">
            <VideoImportButton
              busy={importing}
              disabled={connection !== "online"}
              onImport={onImport}
            />
            <span className={`connection ${connection}`}>
              <i />
              {connection === "online"
                ? "本地分析服务已连接"
                : connection === "loading"
                  ? "正在读取本地视频"
                  : "本地服务未连接"}
            </span>
          </div>
        </header>
        {(importMessage || importError) && (
          <p className={`import-feedback ${importError ? "error" : ""}`}>
            {importError ?? importMessage}
          </p>
        )}
        {connection === "offline" ? (
          <div className="offline">
            <div>
              <strong>等待本地分析服务</strong>
              <p>启动平台后会自动读取 video 文件夹。</p>
            </div>
            <button onClick={onRetry}>重新连接</button>
          </div>
        ) : videos.length ? (
          <div className="case-grid">
            {videos.map((video, index) => (
              <button
                className="case-card"
                key={video.id}
                onClick={() => onOpen(video)}
              >
                <div className="case-image">
                  <video
                    src={`${API}/api/videos/${video.id}/stream#t=4`}
                    muted
                    preload="metadata"
                  />
                  <span className="number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="duration">{timeLabel(video.duration)}</span>
                  {video.latest_analysis_id && (
                    <span className="ready">已分析</span>
                  )}
                </div>
                <div className="case-copy">
                  <span>本地授权素材</span>
                  <h3>{caseName(video, index)}</h3>
                  <p>
                    {video.width || "—"} × {video.height || "—"} ·{" "}
                    {video.fps || "—"} FPS
                  </p>
                  <b>预览 →</b>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="offline">
            <div>
              <strong>尚未选择训练视频</strong>
              <p>点击“选择视频”，从电脑中直接选择需要分析的 MP4 文件。</p>
            </div>
            <VideoImportButton busy={importing} onImport={onImport} />
          </div>
        )}
      </section>

      <footer className="site-footer">
        <div>
          <strong>暨南大学“羽光智教”团队出品</strong>
          <span>本地视频分析与 2.5D 训练数据回放</span>
        </div>
        <span>训练建议仅供训练参考</span>
      </footer>
    </main>
  );
}

const hubSectionNames: Record<HubSection, string> = {
  home: "训练中心",
  training: "训练分析",
  analysis: "姿态分析",
  twin: "2.5D 回放",
  reports: "训练报告",
  models: "模型选择",
};

function Sidebar({
  section,
  onSection,
  onExit,
}: {
  section: HubSection;
  onSection: (section: HubSection) => void;
  onExit: () => void;
}) {
  return (
    <aside className="hub-sidebar">
      <button className="hub-logo" onClick={onExit} aria-label="返回官网首页">
        <span>
          <Shuttle />
        </span>
        <strong>羽光</strong>
      </button>
      <nav aria-label="平台功能导航">
        {(
          [
            ["home", "⌂", "训练中心"],
            ["training", "▦", "训练分析"],
            ["analysis", "◉", "姿态分析"],
            ["twin", "◇", "2.5D 回放"],
            ["reports", "▤", "训练报告"],
            ["models", "◎", "模型选择"],
          ] as [HubSection, string, string][]
        ).map(([key, icon, label]) => (
          <button
            key={key}
            className={section === key ? "active" : ""}
            onClick={() => onSection(key)}
          >
            <i>{icon}</i>
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="hub-empty">
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
      {action}
    </div>
  );
}

function HubFeatureView({
  section,
  activeVideo,
  session,
  result,
  health,
  onOpen,
}: {
  section: Exclude<HubSection, "home">;
  activeVideo: VideoItem | null;
  session: ActiveSession;
  result: Analysis | null;
  health: HealthPayload | null;
  onOpen: (video: VideoItem) => void;
}) {
  const [poseData, setPoseData] = useState<PosePayload | null>(null);
  const [poseStatus, setPoseStatus] = useState<
    "idle" | "loading" | "ready" | "low-confidence" | "error"
  >("idle");
  const [poseError, setPoseError] = useState<string | null>(null);
  const [poseRequest, setPoseRequest] = useState({ token: 0, force: false });
  const [poseTime, setPoseTime] = useState(session.segment_start);
  const [poseWindowStart, setPoseWindowStart] = useState(
    session.segment_start,
  );
  const poseVideoRef = useRef<HTMLVideoElement>(null);
  const twinVideoRef = useRef<HTMLVideoElement>(null);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);

  useEffect(() => {
    if (section !== "analysis" || !activeVideo) return;
    const controller = new AbortController();
    let beginTimer = 0;
    const requestedVideoId = activeVideo.id;
    const start = Math.max(session.segment_start, poseWindowStart);
    const availableDuration = Math.max(
      2,
      Math.min(
        POSE_WINDOW_DURATION,
        (session.segment_end ?? activeVideo.duration) - start,
      ),
    );
    const query = new URLSearchParams({
      start: String(start),
      duration: String(availableDuration),
      sample_fps: "6",
      player_side: session.player_side,
      force_recompute: String(poseRequest.force),
    });
    beginTimer = window.setTimeout(() => {
      setPoseData(null);
      setPoseError(null);
      setPoseStatus("loading");
      apiJson<PosePayload>(
        `${API}/api/videos/${requestedVideoId}/pose?${query}`,
        { signal: controller.signal },
      )
        .then((payload) => {
          if (payload.video_id !== requestedVideoId) {
            throw new Error("姿态结果与当前视频不匹配");
          }
          setPoseData(payload);
          setPoseStatus(payload.frames.length ? "ready" : "low-confidence");
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setPoseStatus("error");
          setPoseError(
            error instanceof Error ? error.message : "姿态服务异常",
          );
        });
    }, 0);
    return () => {
      window.clearTimeout(beginTimer);
      controller.abort();
    };
  }, [
    activeVideo,
    poseRequest,
    section,
    session.player_side,
    session.segment_end,
    session.segment_start,
    poseWindowStart,
  ]);

  useEffect(() => {
    if (
      section !== "twin" ||
      !replayPlaying ||
      !result?.tracks.length
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      setReplayIndex((value) => (value + 1) % result.tracks.length);
    }, 120);
    return () => window.clearInterval(timer);
  }, [replayPlaying, result, section]);

  useEffect(() => {
    const video = twinVideoRef.current;
    const track = result?.tracks[replayIndex];
    if (section !== "twin" || !video || !track) return;
    const targetTime = Math.max(
      0,
      Math.min(track.t, video.duration || activeVideo?.duration || track.t),
    );
    if (Math.abs(video.currentTime - targetTime) > 0.12) {
      video.currentTime = targetTime;
    }
    if (replayPlaying) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [activeVideo?.duration, replayIndex, replayPlaying, result, section]);

  if (section === "training") {
    return (
      <section className="hub-content hub-feature">
        <header className="feature-heading">
          <div>
            <span className="section-label">TRAINING ANALYSIS</span>
            <h1>训练分析</h1>
          </div>
        </header>
        <EmptyState
          title="尚未选择训练视频"
          detail="请先到训练中心选择视频和分析区间。"
        />
      </section>
    );
  }

  if (section === "analysis") {
    if (!activeVideo) {
      return (
        <section className="hub-content hub-feature">
          <EmptyState
            title="尚未选择视频"
            detail="请先从训练中心选择一个本地视频。"
          />
        </section>
      );
    }
    const poseFrame = poseData?.frames.reduce<PoseFrame | null>(
      (closest, item) => {
        if (!closest) return item;
        return Math.abs(item.t - poseTime) < Math.abs(closest.t - poseTime)
          ? item
          : closest;
      },
      null,
    );
    const alignedPose =
      poseFrame && Math.abs(poseFrame.t - poseTime) <= 0.35
        ? poseFrame
        : null;
    return (
      <section className="hub-content hub-feature analysis-workspace">
        <header className="feature-heading">
          <div>
            <span className="section-label">REAL POSE PIPELINE</span>
            <h1>姿态分析实验室</h1>
            <p>
              区分姿态服务异常与低置信度，并显示采样帧、有效帧、平均置信度和缓存来源。
            </p>
          </div>
          <button
            className="solid-btn"
            disabled={poseStatus === "loading"}
            onClick={() =>
              setPoseRequest((value) => ({
                token: value.token + 1,
                force: true,
              }))
            }
          >
            {poseStatus === "loading" ? "正在推理…" : "强制重新推理"}
          </button>
        </header>
        <div className="analysis-lab-grid">
          <article className="vision-console">
            <header>
              <span>
                <i />
                {caseName(activeVideo)}
              </span>
              <b>{poseData?.source === "cache" ? "缓存" : "实时"}</b>
            </header>
            <div className="vision-feed">
              <video
                ref={poseVideoRef}
                src={`${API}/api/videos/${activeVideo.id}/stream`}
                muted
                controls
                playsInline
                onLoadedMetadata={(event) => {
                  event.currentTarget.currentTime =
                    poseData?.start ?? session.segment_start;
                }}
                onTimeUpdate={(event) => {
                  const nextTime = event.currentTarget.currentTime;
                  setPoseTime(nextTime);
                  const segmentEnd =
                    session.segment_end ?? activeVideo.duration;
                  const boundedTime = Math.max(
                    session.segment_start,
                    Math.min(nextTime, Math.max(session.segment_start, segmentEnd - 0.001)),
                  );
                  const nextWindowStart =
                    session.segment_start +
                    Math.floor(
                      (boundedTime - session.segment_start) /
                        POSE_WINDOW_SECONDS,
                    ) *
                      POSE_WINDOW_SECONDS;
                  setPoseWindowStart((current) =>
                    Math.abs(current - nextWindowStart) < 0.001
                      ? current
                      : nextWindowStart,
                  );
                }}
              />
              {alignedPose && (
                <>
                  <span
                    className="detect-box real-pose-box"
                    style={{
                      left: `${alignedPose.bbox.x * 100}%`,
                      top: `${alignedPose.bbox.y * 100}%`,
                      width: `${alignedPose.bbox.w * 100}%`,
                      height: `${alignedPose.bbox.h * 100}%`,
                    }}
                  >
                    <b>BLAZEPOSE · REAL</b>
                    <i>{Math.round(alignedPose.confidence * 100)}%</i>
                  </span>
                  <svg
                    className="real-pose-svg"
                    viewBox="0 0 1 1"
                    preserveAspectRatio="none"
                    aria-label="与当前视频时间对齐的真实姿态关键点"
                  >
                    {poseConnections.map(([from, to]) => {
                      const a = alignedPose.landmarks[from];
                      const b = alignedPose.landmarks[to];
                      if (
                        !a ||
                        !b ||
                        a.visibility < 0.5 ||
                        b.visibility < 0.5
                      ) {
                        return null;
                      }
                      return (
                        <line
                          key={`${from}-${to}`}
                          x1={a.x}
                          y1={a.y}
                          x2={b.x}
                          y2={b.y}
                          vectorEffect="non-scaling-stroke"
                        />
                      );
                    })}
                    {alignedPose.landmarks
                      .slice(11, 33)
                      .map((point) =>
                        point.visibility >= 0.5 ? (
                          <circle
                            key={point.id}
                            cx={point.x}
                            cy={point.y}
                            r=".0065"
                            vectorEffect="non-scaling-stroke"
                          />
                        ) : null,
                      )}
                  </svg>
                </>
              )}
            </div>
            <footer>
              <span>{timeLabel(poseData?.start ?? 0, true)}</span>
              <i>
                <b
                  style={{
                    width: `${poseData?.sampled_frames ? (poseData.accepted_frames / poseData.sampled_frames) * 100 : 0}%`,
                  }}
                />
              </i>
              <span>{timeLabel(poseData?.end ?? 0, true)}</span>
            </footer>
          </article>
          <aside className="pipeline-panel">
            <header>
              <span>POSE OBSERVABILITY</span>
              <b>{poseStatus.toUpperCase()}</b>
            </header>
            <div className="live-tensors">
              <span>
                <small>采样帧</small>
                <b>{poseData?.sampled_frames ?? "—"}</b>
              </span>
              <span>
                <small>有效帧</small>
                <b>{poseData?.accepted_frames ?? "—"}</b>
              </span>
              <span>
                <small>平均置信度</small>
                <b>
                  {poseData
                    ? `${Math.round(poseData.average_confidence * 100)}%`
                    : "—"}
                </b>
              </span>
              <span>
                <small>数据来源</small>
                <b>{poseData?.source ?? "—"}</b>
              </span>
            </div>
            <div className={`pose-runtime pose-runtime-panel ${poseStatus}`}>
              <i />
              {poseStatus === "loading"
                ? `正在分析 ${timeLabel(poseWindowStart, true)} 起的片段…`
                : poseStatus === "ready"
                  ? `${poseData?.model} · ${poseData?.accepted_frames}/${poseData?.sampled_frames} 有效帧`
                  : poseStatus === "low-confidence"
                    ? poseData?.failure_reason
                    : poseStatus === "error"
                      ? `姿态服务异常：${poseError}`
                      : "等待姿态分析"}
            </div>
            <p className="runtime-note">
              {health?.pose_available
                ? `姿态服务可用 · MediaPipe ${poseData?.model_version ?? ""}`
                : `姿态服务不可用 · ${health?.pose_error ?? "后端未连接"}`}
            </p>
            <button
              className="outline-btn"
              onClick={() => onOpen(activeVideo)}
            >
              重新选择分析区间 →
            </button>
          </aside>
        </div>
      </section>
    );
  }

  if (section === "twin") {
    if (!activeVideo || !result || result.video_id !== activeVideo.id) {
      return (
        <section className="hub-content hub-feature">
          <header className="feature-heading">
            <div>
              <span className="section-label">2.5D DATA REPLAY</span>
              <h1>2.5D 训练数据回放（研发预览）</h1>
            </div>
          </header>
          <EmptyState
            title="当前视频尚无可回放结果"
            detail="完成真实分析后才会显示跑位轨迹；系统不会循环播放演示动画。"
            action={
              activeVideo ? (
                <button
                  className="solid-btn"
                  onClick={() => onOpen(activeVideo)}
                >
                  去分析当前视频
                </button>
              ) : null
            }
          />
        </section>
      );
    }
    const track = result.tracks[replayIndex] ?? result.tracks[0];
    const route = result.tracks
      .slice(0, replayIndex + 1)
      .map((item) => `${(item.x / 6.1) * 100},${(item.y / 13.4) * 100}`)
      .join(" ");
    return (
      <section className="hub-content hub-feature twin-workspace">
        <header className="feature-heading">
          <div>
            <span className="section-label">2.5D DATA REPLAY</span>
            <h1>2.5D 训练数据回放（研发预览）</h1>
            <p>
              只读取当前 analysis_id 的真实 OpenCV 跑位坐标；这不是物理仿真或策略预测。
            </p>
          </div>
          <div className="replay-actions">
            <button
              className="outline-btn"
              onClick={() => {
                setReplayPlaying(false);
                setReplayIndex(0);
              }}
            >
              归零
            </button>
            <button
              className="solid-btn"
              onClick={() => setReplayPlaying((value) => !value)}
            >
              {replayPlaying ? "Ⅱ 暂停" : "▶ 播放"}
            </button>
          </div>
        </header>
        <div className="twin-lab-grid">
          <article className="court-model-card real-replay-card">
            <header>
              <span>REAL COURT COORDINATES</span>
              <b>{timeLabel(track?.t ?? 0, true)}</b>
            </header>
            <div className="real-replay-court">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                <rect x="1" y="1" width="98" height="98" />
                <line x1="50" y1="1" x2="50" y2="99" />
                <line x1="1" y1="50" x2="99" y2="50" />
                <line x1="1" y1="15" x2="99" y2="15" />
                <line x1="1" y1="85" x2="99" y2="85" />
                <polyline points={route} className="real-replay-route" />
                {track && (
                  <circle
                    cx={(track.x / 6.1) * 100}
                    cy={(track.y / 13.4) * 100}
                    r="2.5"
                    className="real-replay-player"
                  />
                )}
              </svg>
            </div>
            <input
              aria-label="真实轨迹回放进度"
              type="range"
              min="0"
              max={Math.max(0, result.tracks.length - 1)}
              value={Math.min(replayIndex, result.tracks.length - 1)}
              onChange={(event) => {
                setReplayPlaying(false);
                setReplayIndex(Number(event.target.value));
              }}
            />
          </article>
          <aside className="twin-data-stack">
            <div>
              <small>当前坐标</small>
              <b>X {metricLabel(track?.x, 2)} m</b>
              <b>Y {metricLabel(track?.y, 2)} m</b>
              <b>置信 {track ? `${Math.round(track.confidence * 100)}%` : "—"}</b>
            </div>
            <div>
              <small>数据说明</small>
              <span>轨迹点 <b>{result.tracks.length}</b></span>
              <span>模型 <b>{result.model_version}</b></span>
              <span>来源 <b>{session.source ?? result.source}</b></span>
            </div>
            <div className="twin-video-reference">
              <video
                ref={twinVideoRef}
                src={`${API}/api/videos/${activeVideo.id}/stream`}
                muted
                playsInline
                preload="metadata"
                aria-label="同步视频参考"
                onLoadedMetadata={(event) => {
                  event.currentTarget.currentTime = track?.t ?? 0;
                }}
              />
            </div>
          </aside>
        </div>
      </section>
    );
  }

  if (section === "reports") {
    if (!activeVideo || !result || result.video_id !== activeVideo.id) {
      return (
        <section className="hub-content hub-feature report-workspace">
          <header className="feature-heading">
            <div>
              <span className="section-label">EVIDENCE REPORT</span>
              <h1>训练诊断与建议</h1>
            </div>
          </header>
          <EmptyState
            title="没有当前视频的报告"
            detail="缺少真实结果时，所有得分、置信度和建议均显示为空，不使用演示回退值。"
          />
        </section>
      );
    }
    return (
      <section className="hub-content hub-feature report-workspace">
        <header className="feature-heading">
          <div>
            <span className="section-label">EVIDENCE REPORT</span>
            <h1>训练诊断与建议</h1>
            <p>{caseName(activeVideo)} · 所有建议绑定规则、阈值和证据时间戳。</p>
          </div>
          <button className="solid-btn" onClick={() => window.print()}>
            打印当前报告
          </button>
        </header>
        <div className="report-score-row">
          <span>
            <small>回中效率</small>
            <b>{metricLabel(result.metrics.return_efficiency, 1)}</b>
            <em>分</em>
          </span>
          <span>
            <small>场区覆盖</small>
            <b>{metricLabel(result.metrics.coverage, 1)}%</b>
            <em>标准网格</em>
          </span>
          <span>
            <small>移动距离</small>
            <b>{metricLabel(result.metrics.distance, 1)}m</b>
            <em>有效步长累计</em>
          </span>
          <span>
            <small>有效轨迹</small>
            <b>{metricLabel(result.metrics.valid_track_ratio, 1)}%</b>
            <em>非姿态评分</em>
          </span>
        </div>
        <div className="report-meta">
          <span>analysis_id：{result.analysis_id}</span>
          <span>
            区间：{timeLabel(result.segment.start, true)}–
            {timeLabel(result.segment.end, true)}
          </span>
          <span>
            生成：{new Date(result.created_at * 1000).toLocaleString("zh-CN")}
          </span>
          <span>模型：{result.model_version}</span>
          <span>规则：{result.rule_version}</span>
          <span>来源：{session.source ?? result.source}</span>
        </div>
        <article className="recommendation-list report-recommendations">
          <header>
            <span>规则训练建议</span>
            <b>{result.advice.length} ITEMS</b>
          </header>
          {result.advice.map((item, index) => (
            <section key={`${item.metric}-${index}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>{item.title}</h3>
                <p>{item.observation}</p>
                <p>{item.action}</p>
                <small>
                  {item.metric} {item.operator} {item.threshold ?? "pass"} ·{" "}
                  {item.rule_version} · {Math.round(item.confidence * 100)}%
                </small>
              </div>
              <button onClick={() => onOpen(activeVideo)}>
                证据 {timeLabel(item.evidence_time)} →
              </button>
            </section>
          ))}
        </article>
      </section>
    );
  }

  return (
    <section className="hub-content hub-feature model-workspace">
      <header className="feature-heading">
        <div>
          <span className="section-label">MODEL SELECTION</span>
          <h1>模型选择</h1>
          <p>人体姿态模型单选；羽球追踪模型可与姿态模型同时运行。</p>
        </div>
        <span
          className={`all-systems ${health?.status === "ok" ? "" : "error"}`}
        >
          <i /> {health?.status === "ok" ? "LOCAL API READY" : "API OFFLINE"}
        </span>
      </header>
      <section className="model-role">
        <header>
          <div>
            <span>POSE MODEL</span>
            <h2>人体姿态模型</h2>
          </div>
          <b>当前仅可使用 1 个</b>
        </header>
        <div className="model-choice-grid">
          <article className="model-choice-card selected">
            <header>
              <span>MediaPipe</span>
              <i className="available">
                {health?.pose_available ? "可用" : "不可用"}
              </i>
            </header>
            <h3>MediaPipe BlazePose</h3>
            <p>当前视频关节追踪与姿态关键点模型。</p>
            <footer>
              <small>{health?.pose_error ?? "当前版本"}</small>
              <button disabled>✓ 当前使用</button>
            </footer>
          </article>
          <article className="model-choice-card planned">
            <header>
              <span>MMPose</span>
              <i className="planned">后续版本</i>
            </header>
            <h3>RTMPose</h3>
            <p>实时人体姿态模型预留入口。</p>
            <footer>
              <small>尚未接入</small>
              <button disabled>后续版本</button>
            </footer>
          </article>
          <article className="model-choice-card planned">
            <header>
              <span>MMPose</span>
              <i className="planned">后续版本</i>
            </header>
            <h3>DWPose</h3>
            <p>全身关键点姿态模型预留入口。</p>
            <footer>
              <small>尚未接入</small>
              <button disabled>后续版本</button>
            </footer>
          </article>
        </div>
      </section>

      <section className="model-role">
        <header>
          <div>
            <span>SHUTTLE TRACKING</span>
            <h2>羽球追踪模型</h2>
          </div>
          <b>后续可与姿态模型并存</b>
        </header>
        <div className="model-choice-grid compact">
          <article className="model-choice-card planned">
            <header>
              <span>TrackNet</span>
              <i className="planned">后续版本</i>
            </header>
            <h3>TrackNetV3</h3>
            <p>羽毛球检测与飞行轨迹模型预留入口。</p>
            <footer>
              <small>尚未接入</small>
              <button disabled>后续版本</button>
            </footer>
          </article>
          <article className="model-choice-card selected support-model">
            <header>
              <span>OpenCV</span>
              <i className="available">运行中</i>
            </header>
            <h3>OpenCV Motion Baseline</h3>
            <p>当前固定机位球员移动与场区映射模型。</p>
            <footer>
              <small>{health?.model_version ?? "当前版本"}</small>
              <button disabled>✓ 已启用</button>
            </footer>
          </article>
        </div>
      </section>

      <p className="model-coexistence-note">
        本页仅预留后续模型的前端入口，不会加载额外模型或改变当前分析流程。
      </p>
    </section>
  );
}

function PlatformHub({
  videos,
  connection,
  importing,
  importMessage,
  importError,
  section,
  activeVideo,
  session,
  result,
  health,
  onSection,
  onExit,
  onImport,
  onOpen,
  onRename,
}: {
  videos: VideoItem[];
  connection: "loading" | "online" | "offline";
  importing: boolean;
  importMessage: string | null;
  importError: string | null;
  section: HubSection;
  activeVideo: VideoItem | null;
  session: ActiveSession;
  result: Analysis | null;
  health: HealthPayload | null;
  onSection: (section: HubSection) => void;
  onExit: () => void;
  onImport: (file: File) => Promise<void>;
  onOpen: (video: VideoItem) => void;
  onRename: (video: VideoItem) => void;
}) {
  return (
    <main className="platform-shell">
      <Sidebar section={section} onSection={onSection} onExit={onExit} />
      <div className="hub-main">
        <header className="hub-topbar">
          <div>
            <span>羽光智教平台</span>
            <i>/</i>
            <strong>{hubSectionNames[section]}</strong>
          </div>
          <div>
            <span className={`connection ${connection}`}>
              <i />
              {connection === "online" ? "本地服务在线" : "本地服务离线"}
            </span>
            <span className="hub-avatar">教练</span>
          </div>
        </header>

        {section !== "home" ? (
          <HubFeatureView
            key={`${section}-${activeVideo?.id ?? "none"}-${session.analysis_id ?? "none"}`}
            section={section}
            activeVideo={activeVideo}
            session={session}
            result={result}
            health={health}
            onOpen={onOpen}
          />
        ) : (
          <section className="hub-content">
            <header className="hub-welcome">
              <div>
                <span className="section-label">TRAINING WORKSPACE</span>
                <h1>开始一次训练诊断</h1>
                <p>当前会话贯穿分析、回放与报告；切换视频会立即清空旧状态。</p>
              </div>
              <div className="hub-welcome-actions">
                <VideoImportButton
                  busy={importing}
                  disabled={connection !== "online"}
                  onImport={onImport}
                />
                <button
                  className="outline-btn"
                  onClick={() => activeVideo && onOpen(activeVideo)}
                  disabled={!activeVideo}
                >
                  {activeVideo ? "预览" : "暂无视频"}
                </button>
              </div>
            </header>
            {(importMessage || importError) && (
              <p className={`import-feedback ${importError ? "error" : ""}`}>
                {importError ?? importMessage}
              </p>
            )}

            <section className="hub-primary">
              <article className="continue-card">
                <div className="continue-media">
                  {activeVideo ? (
                    <video
                      src={`${API}/api/videos/${activeVideo.id}/stream#t=4`}
                      muted
                      preload="metadata"
                    />
                  ) : (
                    <div />
                  )}
                  <span className="continue-badge">
                    {session.status === "ready"
                      ? "结果已就绪"
                      : session.status === "running" ||
                          session.status === "queued"
                        ? "分析进行中"
                        : "待分析"}
                  </span>
                  <button
                    onClick={() => activeVideo && onOpen(activeVideo)}
                    disabled={!activeVideo}
                    aria-label="预览当前视频并选择分析区间"
                  >
                    ▶
                  </button>
                </div>
                <div className="continue-copy">
                  <span className="section-label">ACTIVE SESSION</span>
                  <div className="current-video-title">
                    <h2>
                      {activeVideo ? caseName(activeVideo) : "等待训练视频"}
                    </h2>
                    {activeVideo && (
                      <button
                        className="rename-video-btn"
                        type="button"
                        onClick={() => onRename(activeVideo)}
                      >
                        重命名
                      </button>
                    )}
                  </div>
                  <div className="continue-progress">
                    <span>
                      <i
                        style={{
                          width:
                            session.status === "ready"
                              ? "100%"
                              : session.status === "running"
                                ? "55%"
                                : "0%",
                        }}
                      />
                    </span>
                    <b>
                      {session.status === "ready"
                        ? `数据来源：${session.source ?? result?.source ?? "computed"}`
                        : session.error ?? "等待用户操作"}
                    </b>
                  </div>
                  <dl>
                    <div>
                      <dt>回中效率</dt>
                      <dd>
                        {metricLabel(result?.metrics.return_efficiency, 1)}
                      </dd>
                    </div>
                    <div>
                      <dt>场区覆盖</dt>
                      <dd>{metricLabel(result?.metrics.coverage, 1)}%</dd>
                    </div>
                    <div>
                      <dt>有效轨迹</dt>
                      <dd>
                        {metricLabel(result?.metrics.valid_track_ratio, 1)}%
                      </dd>
                    </div>
                  </dl>
                  <button
                    className="open-analysis"
                    onClick={() => activeVideo && onOpen(activeVideo)}
                    disabled={!activeVideo}
                  >
                    继续 →
                  </button>
                </div>
              </article>

              <aside className="workflow-card">
                <header>
                  <span className="section-label">SESSION STATE</span>
                  <h2>当前会话</h2>
                </header>
                <ol>
                  <li className={activeVideo ? "done" : ""}>
                    <b>01</b>
                    <div>
                      <strong>选择训练视频</strong>
                    </div>
                    <i>{activeVideo ? "✓" : "→"}</i>
                  </li>
                  <li className={session.calibration_id ? "done" : ""}>
                    <b>02</b>
                    <div>
                      <strong>标定标准球场</strong>
                    </div>
                    <i>{session.calibration_id ? "✓" : "→"}</i>
                  </li>
                  <li className={session.job_id ? "done" : ""}>
                    <b>03</b>
                    <div>
                      <strong>执行分析任务</strong>
                    </div>
                    <i>{session.job_id ? "✓" : "→"}</i>
                  </li>
                  <li className={result ? "done" : ""}>
                    <b>04</b>
                    <div>
                      <strong>生成训练报告</strong>
                    </div>
                    <i>{result ? "✓" : "→"}</i>
                  </li>
                </ol>
              </aside>
            </section>

            <section className="hub-case-section">
              <header>
                <div>
                  <span className="section-label">LOCAL CASES</span>
                  <h2>本地训练案例</h2>
                </div>
                <span>{videos.length} 个视频 · 不上传公网</span>
              </header>
              <div className="hub-case-list">
                {videos.map((video, index) => (
                  <article className="hub-case-item" key={video.id}>
                    <button
                      className="hub-case-open"
                      type="button"
                      onClick={() => onOpen(video)}
                    >
                      <span className="hub-case-index">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div className="hub-case-thumb">
                        <video
                          src={`${API}/api/videos/${video.id}/stream#t=4`}
                          muted
                          preload="metadata"
                        />
                      </div>
                      <div>
                        <strong>{caseName(video, index)}</strong>
                        <small>
                          {video.width || "—"} × {video.height || "—"} ·{" "}
                          {timeLabel(video.duration)}
                        </small>
                      </div>
                      <span
                        className={
                          video.latest_analysis_id
                            ? "case-state ready"
                            : "case-state"
                        }
                      >
                        {video.latest_analysis_id ? "已有结果" : "待分析"}
                      </span>
                      <i>
                        {activeVideo?.id === video.id
                          ? "当前 · 预览"
                          : "预览 →"}
                      </i>
                    </button>
                    <button
                      className="rename-video-btn case-rename-btn"
                      type="button"
                      onClick={() => onRename(video)}
                    >
                      重命名
                    </button>
                  </article>
                ))}
              </div>
            </section>
          </section>
        )}
      </div>
    </main>
  );
}

function AnalysisView({
  video,
  session,
  result,
  onBack,
  onNavigate,
  onSessionChange,
  onAnalysisReady,
}: {
  video: VideoItem;
  session: ActiveSession;
  result: Analysis | null;
  onBack: () => void;
  onNavigate: (section: HubSection) => void;
  onSessionChange: (patch: Partial<ActiveSession>) => void;
  onAnalysisReady: (
    analysis: Analysis,
    jobId: string,
    source: "computed" | "cache",
    calibrationId: string,
  ) => void;
}) {
  const [points, setPoints] = useState<number[][]>([]);
  const [side, setSide] = useState<"near" | "far">(session.player_side);
  const [job, setJob] = useState<JobPayload | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(video.duration);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [segmentStart, setSegmentStart] = useState(session.segment_start);
  const [segmentEnd, setSegmentEnd] = useState(
    Math.min(
      session.segment_end ?? video.duration,
      session.segment_start + MAX_ANALYSIS_SEGMENT_SECONDS,
    ),
  );
  const [showCalibration, setShowCalibration] = useState(!result);
  const player = useRef<HTMLVideoElement>(null);
  const requestSerial = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const currentVideoId = video.id;
    apiJson<{
      video_id: string;
      calibration_id: string | null;
      version: number;
      points: number[][];
      player_side: "near" | "far";
      source: "existing" | "template";
    }>(`${API}/api/videos/${currentVideoId}/calibration`, {
      signal: controller.signal,
    })
      .then((calibration) => {
        if (calibration.video_id !== currentVideoId) return;
        if (calibration.source === "existing") {
          setPoints(calibration.points);
          setSide(calibration.player_side);
          onSessionChange({
            calibration_id: calibration.calibration_id,
            player_side: calibration.player_side,
          });
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setActionError(
            error instanceof Error ? error.message : "读取标定失败",
          );
        }
      });
    return () => {
      controller.abort();
      requestSerial.current += 1;
    };
  }, [onSessionChange, video.id]);

  function calibrate(event: ReactMouseEvent<HTMLDivElement>) {
    if (!showCalibration || points.length >= 4) return;
    const box = event.currentTarget.getBoundingClientRect();
    const point = [
      (event.clientX - box.left) / box.width,
      (event.clientY - box.top) / box.height,
    ];
    setPoints((current) => [...current, point]);
    setActionError(null);
  }

  async function analyze(forceRecompute: boolean) {
    if (points.length !== 4) {
      setActionError("请按顺序完成四点球场标定，或使用推荐标定后再分析。");
      setShowCalibration(true);
      return;
    }
    const end = Math.min(segmentEnd, duration || video.duration);
    const analysisDuration = end - segmentStart;
    if (analysisDuration < MIN_ANALYSIS_SEGMENT_SECONDS) {
      setActionError("分析区间至少需要 5 秒。");
      return;
    }
    if (analysisDuration > MAX_ANALYSIS_SEGMENT_SECONDS) {
      setActionError("分析区间不能超过 30 分钟。");
      return;
    }
    const serial = ++requestSerial.current;
    setAnalyzing(true);
    setJob(null);
    setActionError(null);
    setActionMessage(forceRecompute ? "正在强制重新计算…" : "正在查询可用缓存…");
    try {
      const calibration = await apiJson<{
        video_id: string;
        calibration_id: string;
        version: number;
      }>(`${API}/api/videos/${video.id}/calibration`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points, player_side: side }),
      });
      if (serial !== requestSerial.current || calibration.video_id !== video.id)
        return;
      const created = await apiJson<{
        job_id: string;
        analysis_id: string | null;
        status: string;
        source: "computed" | "cache";
      }>(`${API}/api/analyses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_id: video.id,
          player_side: side,
          calibration_id: calibration.calibration_id,
          start: segmentStart,
          duration: end - segmentStart,
          force_recompute: forceRecompute,
        }),
      });
      setJob({
        id: created.job_id,
        video_id: video.id,
        status: created.status === "completed" ? "completed" : "queued",
        progress: created.status === "completed" ? 100 : 1,
        message:
          created.status === "completed"
            ? "正在加载缓存结果"
            : `任务已提交，正在分析${side === "near" ? "近端" : "远端"}球员`,
        analysis_id: created.analysis_id,
        source: created.source,
        error: null,
      });
      setActionMessage(null);
      onSessionChange({
        calibration_id: calibration.calibration_id,
        job_id: created.job_id,
        analysis_id: created.analysis_id,
        player_side: side,
        status: created.status === "completed" ? "loading" : "queued",
        source: created.source,
        segment_start: segmentStart,
        segment_end: end,
        error: null,
      });

      let analysisId = created.analysis_id;
      if (!analysisId) {
        for (let attempt = 0; attempt < 600; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          if (serial !== requestSerial.current) return;
          const next = await apiJson<JobPayload>(
            `${API}/api/jobs/${created.job_id}`,
          );
          if (next.video_id !== video.id) {
            throw new Error("任务结果与当前视频不匹配");
          }
          setJob(next);
          onSessionChange({
            status: next.status === "completed" ? "loading" : next.status,
            source: next.source,
            error: next.error ?? null,
          });
          if (next.status === "failed") {
            throw new Error(next.error || "分析任务失败");
          }
          if (next.status === "completed") {
            analysisId = next.analysis_id ?? null;
            break;
          }
        }
      }
      if (!analysisId) throw new Error("任务超时，未生成 analysis_id");
      const analysis = await apiJson<Analysis>(
        `${API}/api/analyses/${analysisId}`,
      );
      if (
        serial !== requestSerial.current ||
        analysis.video_id !== video.id ||
        analysis.analysis_id !== analysisId
      ) {
        throw new Error("分析结果归属校验失败");
      }
      onAnalysisReady(
        analysis,
        created.job_id,
        created.source,
        calibration.calibration_id,
      );
      setShowCalibration(false);
      setActionMessage(
        created.source === "cache"
          ? "已加载匹配参数的缓存结果"
          : "已完成重新计算并生成新的 analysis_id",
      );
    } catch (error) {
      if (serial !== requestSerial.current) return;
      const message =
        error instanceof Error ? error.message : "分析服务连接失败";
      setActionError(message);
      onSessionChange({ status: "failed", error: message });
    } finally {
      if (serial === requestSerial.current) setAnalyzing(false);
    }
  }

  function seek(value: number) {
    const media = player.current;
    if (!media) return;
    media.currentTime = Math.max(0, Math.min(value, duration));
    setTime(media.currentTime);
  }

  function jumpTo(value: number) {
    seek(value);
    void player.current?.play();
  }

  const metrics = result?.video_id === video.id ? result.metrics : undefined;
  const tracks = result?.video_id === video.id ? result.tracks : [];
  const currentTrack = tracks.reduce<
    { t: number; x: number; y: number; confidence: number } | undefined
  >((closest, item) => {
    if (!closest) return item;
    return Math.abs(item.t - time) < Math.abs(closest.t - time)
      ? item
      : closest;
  }, undefined);
  const courtPolyline = tracks
    .map(
      (item) =>
        `${32 + (item.x / 6.1) * 256},${25 + (item.y / 13.4) * 390}`,
    )
    .join(" ");
  const maxHeat = Math.max(1, ...(result?.heatmap.flat() ?? [1]));

  return (
    <main className="platform-shell analysis-shell">
      <Sidebar section="training" onSection={onNavigate} onExit={onBack} />
      <div className="hub-main analysis-page">
        <header className="analysis-nav">
          <button className="brand" onClick={onBack}>
            <span>
              <Shuttle />
            </span>
            <strong>羽光智教</strong>
          </button>
          <p>
            训练中心 <i>/</i> {caseName(video)}
          </p>
          <div>
            <button
              className="outline-btn"
              disabled={analyzing}
              onClick={() => void analyze(false)}
            >
              使用匹配缓存
            </button>
            <button
              className="solid-btn"
              disabled={analyzing}
              onClick={() => void analyze(true)}
            >
              {analyzing ? "分析进行中…" : "强制重算"}
            </button>
            <button
              className="outline-btn"
              disabled={!result}
              onClick={() => window.print()}
            >
              生成报告
            </button>
          </div>
        </header>

        <div className="analysis-content">
          <header className="analysis-heading">
            <div>
              <span className="section-label">
                VIDEO / {video.id.slice(0, 8).toUpperCase()}
              </span>
              <h1>单打训练诊断</h1>
            </div>
            <span className={`status ${session.status}`}>
              <i />
              {result
                ? `分析完成 · ${Math.round(result.quality.confidence * 100)}% 轨迹置信度`
                : session.status === "failed"
                  ? "分析失败"
                  : "待分析"}
            </span>
          </header>

          <section className="analysis-focus">
            <div className="video-panel">
              <div className="video-stage">
                <video
                  ref={player}
                  src={`${API}/api/videos/${video.id}/stream`}
                  controls
                  onLoadedMetadata={(event) => {
                    const actualDuration =
                      event.currentTarget.duration || video.duration;
                    setDuration(actualDuration);
                    setSegmentEnd(
                      Math.min(
                        segmentEnd || actualDuration,
                        actualDuration,
                        segmentStart + MAX_ANALYSIS_SEGMENT_SECONDS,
                      ),
                    );
                  }}
                  onTimeUpdate={(event) =>
                    setTime(event.currentTarget.currentTime)
                  }
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                />
                {showCalibration && (
                  <div className="calibration" onClick={calibrate}>
                    {points.map((point, index) => (
                      <span
                        key={`${point[0]}-${point[1]}-${index}`}
                        style={{
                          left: `${point[0] * 100}%`,
                          top: `${point[1] * 100}%`,
                        }}
                      >
                        {index + 1}
                      </span>
                    ))}
                    <div>
                      <strong>
                        {points.length < 4
                          ? `点击${pointLabels[points.length]}`
                          : "球场标定已完成"}
                      </strong>
                      <small>
                        {points.length}/4 · 近左、近右、远右、远左
                      </small>
                    </div>
                  </div>
                )}
                <b
                  className="time-tag"
                  style={{
                    left: `${Math.max(8, Math.min(92, (time / Math.max(duration, 1)) * 100))}%`,
                  }}
                >
                  {timeLabel(time, true)} · 帧{" "}
                  {Math.round(time * (video.fps || 0))}
                </b>
              </div>

              <div className="player-toolbar">
                <button
                  onClick={() =>
                    playing
                      ? player.current?.pause()
                      : void player.current?.play()
                  }
                >
                  {playing ? "Ⅱ 暂停" : "▶ 播放"}
                </button>
                <button onClick={() => seek(time - 5)}>−5 秒</button>
                <button onClick={() => seek(time + 5)}>+5 秒</button>
                <input
                  aria-label="视频进度"
                  type="range"
                  min="0"
                  max={Math.max(duration, 0)}
                  step=".01"
                  value={Math.min(time, duration)}
                  onChange={(event) => seek(Number(event.target.value))}
                />
                <select
                  aria-label="播放倍速"
                  value={playbackRate}
                  onChange={(event) => {
                    const rate = Number(event.target.value);
                    setPlaybackRate(rate);
                    if (player.current) player.current.playbackRate = rate;
                  }}
                >
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}×
                    </option>
                  ))}
                </select>
                <label>
                  音量
                  <input
                    aria-label="音量"
                    type="range"
                    min="0"
                    max="1"
                    step=".05"
                    value={volume}
                    onChange={(event) => {
                      const nextVolume = Number(event.target.value);
                      setVolume(nextVolume);
                      if (player.current) player.current.volume = nextVolume;
                    }}
                  />
                </label>
                <button onClick={() => void player.current?.requestFullscreen()}>
                  全屏
                </button>
              </div>

              <div className="segment-toolbar">
                <span>
                  分析区间：{timeLabel(segmentStart, true)} –{" "}
                  {timeLabel(segmentEnd, true)}
                </span>
                <button
                  onClick={() =>
                    setSegmentStart(
                      Math.max(
                        0,
                        segmentEnd - MAX_ANALYSIS_SEGMENT_SECONDS,
                        Math.min(
                          time,
                          segmentEnd - MIN_ANALYSIS_SEGMENT_SECONDS,
                        ),
                      ),
                    )
                  }
                >
                  当前设为起点
                </button>
                <button
                  onClick={() =>
                    setSegmentEnd(
                      Math.min(
                        duration,
                        segmentStart + MAX_ANALYSIS_SEGMENT_SECONDS,
                        Math.max(
                          time,
                          segmentStart + MIN_ANALYSIS_SEGMENT_SECONDS,
                        ),
                      ),
                    )
                  }
                >
                  当前设为终点
                </button>
              </div>

              <div className="analysis-controls">
                <div>
                  <span>分析球员</span>
                  <button
                    className={side === "near" ? "active" : ""}
                    disabled={analyzing}
                    onClick={() => setSide("near")}
                  >
                    近端球员
                  </button>
                  <button
                    className={side === "far" ? "active" : ""}
                    disabled={analyzing}
                    onClick={() => setSide("far")}
                  >
                    远端球员
                  </button>
                </div>
                <button
                  className="outline-btn"
                  disabled={!points.length || analyzing}
                  onClick={() =>
                    setPoints((current) => current.slice(0, -1))
                  }
                >
                  撤销一点
                </button>
                <button
                  className="outline-btn"
                  disabled={analyzing}
                  onClick={() => {
                    setPoints([]);
                    setShowCalibration(true);
                  }}
                >
                  全部重置
                </button>
                <button
                  className="outline-btn"
                  disabled={analyzing}
                  onClick={() => {
                    setPoints(calibrationPreset);
                    setShowCalibration(true);
                  }}
                >
                  推荐标定
                </button>
                <button
                  className="solid-btn"
                  disabled={analyzing}
                  onClick={() => void analyze(false)}
                >
                  {analyzing ? "分析中…" : "开始智能分析"}
                </button>
              </div>

              {(job || actionMessage || actionError) && (
                <div className={`job ${actionError ? "failed" : ""}`}>
                  <div>
                    <strong>
                      {actionError ??
                        job?.message ??
                        actionMessage ??
                        "准备分析"}
                    </strong>
                    <small>
                      {job?.source
                        ? `数据来源：${job.source}`
                        : "缓存与重新计算状态将明确展示"}
                    </small>
                  </div>
                  <b>{job?.progress ?? (result ? 100 : 0)}%</b>
                  <i>
                    <span
                      style={{ width: `${job?.progress ?? (result ? 100 : 0)}%` }}
                    />
                  </i>
                </div>
              )}
            </div>

            <aside className="round-panel">
              <header>
                <span>当前真实轨迹点</span>
                <strong>{timeLabel(currentTrack?.t ?? time, true)}</strong>
              </header>
              <div className="mini-court mini-court-pro">
                {result ? (
                  <svg viewBox="0 0 360 230" role="img">
                    <path
                      className="mini-floor"
                      d="M55 24 L305 24 L340 200 L20 200 Z"
                    />
                    <path
                      className="mini-boundary"
                      d="M55 24 L305 24 L340 200 L20 200 Z M48 64 L312 64 M38 112 L322 112 M28 160 L332 160 M180 24 L180 200"
                    />
                    <polyline
                      className="mini-route-polyline"
                      points={tracks
                        .map(
                          (item) =>
                            `${55 + (item.x / 6.1) * 250},${24 + (item.y / 13.4) * 176}`,
                        )
                        .join(" ")}
                    />
                    {currentTrack && (
                      <circle
                        className="mini-player-dot primary"
                        cx={55 + (currentTrack.x / 6.1) * 250}
                        cy={24 + (currentTrack.y / 13.4) * 176}
                        r="8"
                      />
                    )}
                  </svg>
                ) : (
                  <p>完成分析后显示当前视频的真实跑位点。</p>
                )}
              </div>
              <label>
                ◎ {side === "near" ? "近端球员" : "远端球员"}
              </label>
              <button
                className="twin-btn"
                disabled={!result}
                onClick={() => onNavigate("twin")}
              >
                ▶ 进入 2.5D 数据回放
              </button>
            </aside>
          </section>

          <section className="overview">
            <h2>本段表现概览</h2>
            <div className="metric-strip">
              <span>
                <small>移动距离</small>
                <b>
                  {metricLabel(metrics?.distance, 1)}
                  <em> m</em>
                </b>
              </span>
              <span>
                <small>场区覆盖</small>
                <b>
                  {metricLabel(metrics?.coverage, 1)}
                  <em>%</em>
                </b>
              </span>
              <span>
                <small>回中效率</small>
                <b>{metricLabel(metrics?.return_efficiency, 1)}</b>
              </span>
              <span>
                <small>有效轨迹占比</small>
                <b>
                  {metricLabel(metrics?.valid_track_ratio, 1)}
                  <em>%</em>
                </b>
              </span>
            </div>
          </section>

          <section className="lower-analysis">
            <article className="heat-panel">
              <header>
                <span>
                  <small>SPATIAL ANALYSIS</small>
                  <b>真实热力与移动路径</b>
                </span>
                <em>标准单打场地 · 俯视图</em>
              </header>
              <div className="heat-court heat-court-pro">
                {result ? (
                  <svg viewBox="0 0 320 440" role="img">
                    <rect
                      x="32"
                      y="25"
                      width="256"
                      height="390"
                      rx="3"
                      className="heat-floor"
                    />
                    {result.heatmap.flatMap((row, rowIndex) =>
                      row.map((value, columnIndex) => (
                        <rect
                          key={`${rowIndex}-${columnIndex}`}
                          x={32 + (columnIndex * 256) / 6}
                          y={25 + (rowIndex * 390) / 8}
                          width={256 / 6}
                          height={390 / 8}
                          fill="#ff6e63"
                          opacity={(value / maxHeat) * 0.72}
                        />
                      )),
                    )}
                    <path
                      className="heat-lines"
                      d="M32 25 H288 V415 H32 Z M52 25 V415 M268 25 V415 M32 82 H288 M32 220 H288 M32 358 H288 M160 25 V415"
                    />
                    <polyline
                      className="heat-route-main"
                      points={courtPolyline}
                    />
                  </svg>
                ) : (
                  <EmptyState title="等待真实轨迹" />
                )}
              </div>
              <div className="heat-explanation">
                <h3>数据说明</h3>
                <p>
                  {result
                    ? `${result.tracks.length} 个有效轨迹点，按时间映射到标准单打球场；有效轨迹占比不是姿态置信度。`
                    : "完成分析后显示真实数据来源、轨迹点数与映射说明。"}
                </p>
              </div>
            </article>

            <article className="advice-panel">
              <header>
                <span>
                  <small>RULE EVIDENCE</small>
                  <b>训练建议</b>
                </span>
                <em>{result ? `${result.advice.length} 条建议` : "等待分析"}</em>
              </header>
              <div>
                {result ? (
                  result.advice.map((item, index) => (
                    <section
                      key={`${item.metric}-${index}`}
                      className="coaching-card"
                    >
                      <span className="advice-index">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div className="advice-body">
                        <div className="advice-title-row">
                          <h3>{item.title}</h3>
                          <strong>
                            {Math.round(item.confidence * 100)}% 规则置信度
                          </strong>
                        </div>
                        <p className="advice-summary">{item.observation}</p>
                        <div className="diagnostic-block prescription-block">
                          <small>具体训练建议</small>
                          <p>{item.action}</p>
                        </div>
                        <div className="training-target">
                          <span>
                            <small>触发规则</small>
                            {item.metric} {item.operator}{" "}
                            {item.threshold ?? "pass"}
                          </span>
                          <span>
                            <small>规则版本</small>
                            {item.rule_version}
                          </span>
                        </div>
                        <div className="advice-source">
                          知识来源：{item.knowledge_source ?? item.source}
                        </div>
                      </div>
                      <button onClick={() => jumpTo(item.evidence_time)}>
                        ▶ 回看证据 {timeLabel(item.evidence_time)}
                      </button>
                    </section>
                  ))
                ) : (
                  <EmptyState title="暂无训练建议" />
                )}
              </div>
            </article>
          </section>

          {result && (
            <section className="analysis-metadata">
              <span>analysis_id：{result.analysis_id}</span>
              <span>video_id：{result.video_id}</span>
              <span>
                区间：{timeLabel(result.segment.start, true)}–
                {timeLabel(result.segment.end, true)}
              </span>
              <span>模型：{result.model_version}</span>
              <span>规则：{result.rule_version}</span>
              <span>来源：{session.source ?? result.source}</span>
            </section>
          )}
          <p className="disclaimer">
            训练建议仅供训练参考 · 视频仅在本机处理 · 不做人脸识别
          </p>
        </div>
      </div>
    </main>
  );
}

export default function Home() {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [screen, setScreen] = useState<"landing" | "platform">("landing");
  const [hubSection, setHubSection] = useState<HubSection>("home");
  const [connection, setConnection] = useState<
    "loading" | "online" | "offline"
  >("loading");
  const [session, setSession] = useState<ActiveSession>(emptySession);
  const [analysisResult, setAnalysisResult] = useState<Analysis | null>(null);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [segmentVideo, setSegmentVideo] = useState<VideoItem | null>(null);
  const [renameTarget, setRenameTarget] = useState<VideoItem | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const activeVideo = useMemo(
    () => videos.find((video) => video.id === session.video_id) ?? null,
    [session.video_id, videos],
  );

  const load = useCallback(async () => {
    setConnection("loading");
    try {
      const [videoList, healthResult] = await Promise.all([
        apiJson<VideoItem[]>(`${API}/api/videos`),
        apiJson<HealthPayload>(`${API}/api/health`),
      ]);
      setVideos(videoList);
      setHealth(healthResult);
      setConnection("online");
      setSession((current) => {
        if (
          current.video_id &&
          videoList.some((video) => video.id === current.video_id)
        ) {
          return current;
        }
        const recent =
          videoList.find((video) => video.latest_analysis_id) ??
          videoList[0] ??
          null;
        if (!recent) return emptySession;
        return {
          ...emptySession,
          video_id: recent.id,
          analysis_id: recent.latest_analysis_id ?? null,
          status: recent.latest_analysis_id ? "loading" : "idle",
        };
      });
    } catch {
      setConnection("offline");
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!session.video_id || !session.analysis_id) return;
    const controller = new AbortController();
    const requestedVideoId = session.video_id;
    const requestedAnalysisId = session.analysis_id;
    apiJson<Analysis>(`${API}/api/analyses/${requestedAnalysisId}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (
          result.video_id !== requestedVideoId ||
          result.analysis_id !== requestedAnalysisId
        ) {
          throw new Error("结果与当前会话不匹配");
        }
        setAnalysisResult(result);
        setSession((current) =>
          current.video_id === requestedVideoId &&
          current.analysis_id === requestedAnalysisId
            ? {
                ...current,
                calibration_id: result.calibration_id,
                player_side: result.player_side,
                status: "ready",
                source: current.source ?? result.source,
                segment_start: result.segment?.start ?? 0,
                segment_end: result.segment?.end ?? null,
                error: null,
              }
            : current,
        );
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setAnalysisResult(null);
        setSession((current) =>
          current.video_id === requestedVideoId &&
          current.analysis_id === requestedAnalysisId
            ? {
                ...current,
                status: "failed",
                error:
                  error instanceof Error ? error.message : "读取分析结果失败",
              }
            : current,
        );
      });
    return () => controller.abort();
  }, [session.analysis_id, session.video_id]);

  useEffect(() => {
    const syncScreen = () => {
      setScreen(
        new URLSearchParams(window.location.search).get("view") === "platform"
          ? "platform"
          : "landing",
      );
    };
    syncScreen();
    window.addEventListener("popstate", syncScreen);
    return () => window.removeEventListener("popstate", syncScreen);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [screen, hubSection]);

  function openVideo(video: VideoItem) {
    setSegmentVideo(video);
  }

  async function importVideo(file: File) {
    if (!file.name.toLowerCase().endsWith(".mp4")) {
      setImportMessage(null);
      setImportError("当前仅支持 MP4 视频，请重新选择。");
      return;
    }
    setImporting(true);
    setImportMessage(null);
    setImportError(null);
    try {
      const imported = await apiJson<VideoItem>(
        `${API}/api/videos/import?filename=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        },
      );
      setVideos((current) => [
        imported,
        ...current.filter((video) => video.id !== imported.id),
      ]);
      setAnalysisResult(null);
      setSession({
        ...emptySession,
        video_id: imported.id,
      });
      setSegmentVideo(imported);
      setImportMessage(`已导入“${imported.name}”，请预览并选择分析区间。`);
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "视频导入失败，请重试。",
      );
    } finally {
      setImporting(false);
    }
  }

  async function renameVideo(displayName: string) {
    if (!renameTarget) return;
    setRenaming(true);
    setRenameError(null);
    try {
      const renamed = await apiJson<VideoItem>(
        `${API}/api/videos/${encodeURIComponent(renameTarget.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ display_name: displayName }),
        },
      );
      setVideos((current) =>
        current.map((video) => (video.id === renamed.id ? renamed : video)),
      );
      setSegmentVideo((current) =>
        current?.id === renamed.id ? renamed : current,
      );
      setAnalysisResult((current) =>
        current?.video_id === renamed.id
          ? {
              ...current,
              video: { ...current.video, display_name: renamed.display_name },
            }
          : current,
      );
      setImportError(null);
      setImportMessage(null);
      setRenameTarget(null);
    } catch (error) {
      setRenameError(
        error instanceof Error ? error.message : "视频重命名失败，请重试。",
      );
    } finally {
      setRenaming(false);
    }
  }

  function confirmSegment(start: number, end: number) {
    if (!segmentVideo) return;
    const selectedDuration = end - start;
    if (
      selectedDuration < MIN_ANALYSIS_SEGMENT_SECONDS ||
      selectedDuration > MAX_ANALYSIS_SEGMENT_SECONDS
    ) {
      setImportMessage(null);
      setImportError("分析片段必须在 5 秒到 30 分钟之间。");
      return;
    }
    const video = segmentVideo;
    setAnalysisResult(null);
    setSession({
      ...emptySession,
      video_id: video.id,
      player_side:
        session.video_id === video.id ? session.player_side : "near",
      calibration_id:
        session.video_id === video.id ? session.calibration_id : null,
      segment_start: start,
      segment_end: end,
    });
    setSegmentVideo(null);
    navigateHub("training");
    setImportMessage(
      `已选择 ${timeLabel(start, true)} – ${timeLabel(end, true)}，后续仅分析该区间。`,
    );
  }

  function changeScreen(next: "landing" | "platform") {
    setScreen(next);
    window.history.pushState(
      { view: next },
      "",
      next === "platform" ? "/?view=platform" : "/",
    );
  }

  function navigateHub(section: HubSection) {
    setHubSection(section);
    setScreen("platform");
    window.history.replaceState(
      { view: "platform", section },
      "",
      "/?view=platform",
    );
  }

  const updateSession = useCallback((patch: Partial<ActiveSession>) => {
    if (
      patch.analysis_id === null &&
      (patch.status === "queued" || patch.status === "running")
    ) {
      setAnalysisResult(null);
    }
    setSession((current) => ({ ...current, ...patch }));
  }, []);

  function handleAnalysisReady(
    result: Analysis,
    jobId: string,
    source: "computed" | "cache",
    calibrationId: string,
  ) {
    setAnalysisResult(result);
    setSession((current) => ({
      ...current,
      video_id: result.video_id,
      calibration_id: calibrationId,
      job_id: jobId,
      analysis_id: result.analysis_id,
      player_side: result.player_side,
      status: "ready",
      source,
      segment_start: result.segment.start,
      segment_end: result.segment.end,
      error: null,
    }));
    setVideos((current) =>
      current.map((video) =>
        video.id === result.video_id
          ? { ...video, latest_analysis_id: result.analysis_id }
          : video,
      ),
    );
  }

  let content: ReactNode;
  if (screen === "platform" && hubSection === "training" && activeVideo) {
    content = (
      <AnalysisView
        key={activeVideo.id}
        video={activeVideo}
        session={session}
        result={
          analysisResult?.video_id === activeVideo.id ? analysisResult : null
        }
        onBack={() => navigateHub("home")}
        onNavigate={navigateHub}
        onSessionChange={updateSession}
        onAnalysisReady={handleAnalysisReady}
      />
    );
  } else if (screen === "platform") {
    content = (
      <PlatformHub
        videos={videos}
        connection={connection}
        importing={importing}
        importMessage={importMessage}
        importError={importError}
        section={hubSection}
        activeVideo={activeVideo}
        session={session}
        result={
          analysisResult?.video_id === session.video_id
            ? analysisResult
            : null
        }
        health={health}
        onSection={setHubSection}
        onExit={() => changeScreen("landing")}
        onImport={importVideo}
        onOpen={openVideo}
        onRename={(video) => {
          setRenameError(null);
          setRenameTarget(video);
        }}
      />
    );
  } else {
    content = (
      <Landing
        videos={videos}
        connection={connection}
        importing={importing}
        importMessage={importMessage}
        importError={importError}
        onRetry={() => void load()}
        onImport={importVideo}
        onOpen={openVideo}
        onEnter={() => changeScreen("platform")}
      />
    );
  }

  return (
    <>
      {content}
      {segmentVideo && (
        <VideoSegmentSelector
          key={segmentVideo.id}
          video={segmentVideo}
          initialStart={
            session.video_id === segmentVideo.id ? session.segment_start : 0
          }
          initialEnd={
            session.video_id === segmentVideo.id ? session.segment_end : null
          }
          onCancel={() => setSegmentVideo(null)}
          onConfirm={confirmSegment}
        />
      )}
      {renameTarget && (
        <VideoRenameDialog
          key={renameTarget.id}
          video={renameTarget}
          busy={renaming}
          error={renameError}
          onCancel={() => {
            if (renaming) return;
            setRenameError(null);
            setRenameTarget(null);
          }}
          onRename={renameVideo}
        />
      )}
    </>
  );
}
