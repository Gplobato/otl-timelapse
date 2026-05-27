import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import {
  Film,
  Upload,
  Download,
  AlertCircle,
  CheckCircle2,
  Loader2,
  RotateCcw,
  FolderArchive,
  Video,
  Zap,
  ShieldCheck,
  Settings2,
  Moon,
  Clock,
  Activity,
  Plus,
  Trash2,
  Play,
  ChevronDown,
  ChevronUp,
  X,
  ListVideo,
  Wand2,
  Images,
  FolderOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  runPipeline,
  saveFile,
  groupFilesByCamera,
  suggestOutputName,
  DEFAULT_FILTERS,
  type RejectedFrame,
  type PipelineMode,
  type ResolutionKey,
  type FilterOptions,
  RESOLUTIONS,
  FPS_OPTIONS,
} from "@/lib/pipeline";
import { runStabilizerPipeline, type StabilizerPhase } from "@/lib/stabilizer-pipeline";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "OTL — ObrasTimeLapse" },
      {
        name: "description",
        content: "Timelapse inteligente para obras — filtragem automática e exportação 4K.",
      },
    ],
  }),
});

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = "idle" | "analyzing" | "motion" | "encoding" | "zipping" | "done" | "error";
type EncodePhase = "loading" | "writing" | "encoding" | "concatenating";
type ActiveTool = "cleaner" | "stabilizer";

type ImportState = {
  active: boolean;
  current: number;
  total: number;
  message: string;
  indeterminate?: boolean;
};

type QueueItem = {
  id: string;
  label: string;
  camera: string;
  project: string;
  files: File[];
  status: "pending" | "processing" | "done" | "error";
  // runtime progress
  phase: Phase;
  analyzed: number;
  motionDone: number;
  motionTotal: number;
  rejectedCount: number;
  encodePhase: EncodePhase;
  encodeCurrent: number;
  encodeTotal: number;
  elapsed: number;
  // result
  result?: {
    videoBlob?: Blob;
    zipBlob?: Blob;
    videoUrl?: string;
    zipUrl?: string;
    size: number;
    usedCount: number;
    totalCount: number;
    rejected: RejectedFrame[];
    suggestedName: string;
  };
  error?: string;
};

const ENCODE_LABELS: Record<EncodePhase, string> = {
  loading: "Verificando suporte…",
  writing: "Preparando frames…",
  encoding: "Codificando frames…",
  concatenating: "Finalizando MP4…",
};

const STABILIZER_PHASE_LABELS: Record<StabilizerPhase, string> = {
  loading: "Carregando arquivos…",
  analyzing: "Analisando estabilidade…",
  stabilizing: "Calculando correções…",
  encoding: "Gerando MP4 estabilizado…",
  finalizing: "Finalizando vídeo…",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}
function fmtTime(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function uid() {
  return Math.random().toString(36).slice(2);
}

function waitForPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

const MAZE_PATH = [
  { x: 8, y: 72 },
  { x: 24, y: 72 },
  { x: 24, y: 30 },
  { x: 46, y: 30 },
  { x: 46, y: 56 },
  { x: 66, y: 56 },
  { x: 66, y: 22 },
  { x: 86, y: 22 },
  { x: 86, y: 72 },
];

function getMazePosition(percent: number) {
  const clamped = Math.max(0, Math.min(100, percent));
  const exact = (clamped / 100) * (MAZE_PATH.length - 1);
  const index = Math.min(MAZE_PATH.length - 2, Math.floor(exact));
  const t = exact - index;
  const a = MAZE_PATH[index];
  const b = MAZE_PATH[index + 1];

  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

function PacmanSvg({ gradientId }: { gradientId: string }) {
  return (
    <svg viewBox="-12 -12 24 24" className="otl-pacman-svg" aria-hidden="true">
      <defs>
        <radialGradient id={gradientId} cx="35%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#fef3c7" />
          <stop offset="45%" stopColor="#fbbf24" />
          <stop offset="100%" stopColor="#ea580c" />
        </radialGradient>
      </defs>
      <path
        d="M 0 0 L 10 0 A 10 10 0 0 0 9.51 -3.09 Z"
        className="otl-pacman-half otl-pacman-top"
        fill={`url(#${gradientId})`}
      />
      <path
        d="M 0 0 L 10 0 A 10 10 0 0 1 9.51 3.09 Z"
        className="otl-pacman-half otl-pacman-bottom"
        fill={`url(#${gradientId})`}
      />
      <path d="M 9.51 -3.09 A 10 10 0 1 0 9.51 3.09 L 0 0 Z" fill={`url(#${gradientId})`} />
      <circle cx="-1.5" cy="-5" r="1.6" fill="#0f172a" />
      <circle cx="-2" cy="-5.5" r="0.6" fill="#fef9c3" opacity="0.9" />
    </svg>
  );
}

function IndeterminateLoader({ label, message }: { label: string; message: string }) {
  const gradientId = useId().replace(/:/g, "");
  return (
    <div className="flex items-center gap-4">
      <div className="relative flex h-14 w-14 items-center justify-center">
        <div className="absolute inset-0 rounded-full border-2 border-orange-500/20" />
        <div className="otl-spinner absolute inset-0 rounded-full border-2 border-transparent border-t-orange-400 border-r-orange-400" />
        <div className="h-8 w-8">
          <PacmanSvg gradientId={`otl-load-${gradientId}`} />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-white">{label}</p>
        <p className="mt-0.5 truncate text-xs text-zinc-400">{message}</p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div className="otl-indeterminate-bar h-full w-1/3 rounded-full bg-gradient-to-r from-orange-500 to-amber-400" />
        </div>
      </div>
    </div>
  );
}

function GhostSvg({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 24 24" className="otl-ghost-inner" aria-hidden="true">
      <path d="M3 12a9 9 0 1 1 18 0v9l-2.5-2-2.5 2-2.5-2-2.5 2-2.5-2L6 22l-3-1z" fill={color} />
      <circle cx="9" cy="11" r="2.4" fill="#ffffff" />
      <circle cx="15" cy="11" r="2.4" fill="#ffffff" />
      <circle cx="9.4" cy="11.4" r="1" fill="#0f172a" />
      <circle cx="15.4" cy="11.4" r="1" fill="#0f172a" />
    </svg>
  );
}

function makeQueueItem(camera: string, project: string, files: File[]): QueueItem {
  const { label } = suggestOutputName(files);
  return {
    id: uid(),
    label,
    camera,
    project,
    files,
    status: "pending",
    phase: "idle",
    analyzed: 0,
    motionDone: 0,
    motionTotal: 0,
    rejectedCount: 0,
    encodePhase: "loading",
    encodeCurrent: 0,
    encodeTotal: 1,
    elapsed: 0,
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ToggleGroup<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: { value: T; label: string; note?: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-zinc-400 uppercase tracking-widest mb-2">{label}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            key={String(opt.value)}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-all disabled:opacity-40 ${
              value === opt.value
                ? "border-orange-500 bg-orange-500/10 text-white"
                : "border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300"
            }`}
          >
            <span className="text-sm font-semibold">{opt.label}</span>
            {opt.note && <span className="text-xs opacity-60 mt-0.5">{opt.note}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function FilterToggle({
  icon: Icon,
  title,
  desc,
  checked,
  onChange,
}: {
  icon: React.ElementType;
  title: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`flex items-start gap-3 w-full rounded-xl border p-3 text-left transition-all ${
        checked
          ? "border-orange-500 bg-orange-500/10"
          : "border-zinc-700 bg-zinc-800/40 hover:border-zinc-600"
      }`}
    >
      <div
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${checked ? "bg-orange-500/20" : "bg-zinc-700"}`}
      >
        <Icon className={`h-3.5 w-3.5 ${checked ? "text-orange-400" : "text-zinc-400"}`} />
      </div>
      <div>
        <p className={`text-sm font-semibold ${checked ? "text-white" : "text-zinc-300"}`}>
          {title}
        </p>
        <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">{desc}</p>
      </div>
      <div
        className={`ml-auto mt-0.5 h-4 w-7 rounded-full transition-colors shrink-0 ${checked ? "bg-orange-500" : "bg-zinc-700"}`}
      >
        <div
          className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-3" : "translate-x-0"}`}
        />
      </div>
    </button>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  unit,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  unit?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-zinc-400 w-28">{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value))))}
        className="w-16 rounded-lg bg-zinc-800 border border-zinc-700 px-2 py-1 text-sm text-white text-center tabular-nums focus:border-orange-500 focus:outline-none"
      />
      {unit && <span className="text-xs text-zinc-500">{unit}</span>}
    </div>
  );
}

// ─── ProgressBar ──────────────────────────────────────────────────────────────

function ProgressBar({
  label,
  sublabel,
  value,
}: {
  label: string;
  sublabel: string;
  value: number;
}) {
  const percent = Math.max(0, Math.min(100, value));
  const pacman = getMazePosition(percent);
  const ghostOne = getMazePosition(Math.max(0, percent - 16));
  const ghostTwo = getMazePosition(Math.max(0, percent - 30));
  const ghostThree = getMazePosition(Math.max(0, percent - 44));
  const gradientId = useId().replace(/:/g, "");
  const dots = [10, 20, 30, 40, 50, 60, 70, 80, 90].map((p) => ({
    progress: p,
    ...getMazePosition(p),
  }));

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <span className="font-medium text-white">{label}</span>
        <span className="text-zinc-400 tabular-nums">
          {Math.round(percent)}% · {sublabel}
        </span>
      </div>
      <div
        className="relative w-full overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/90"
        style={{ aspectRatio: "5 / 1.1", minHeight: "6rem" }}
      >
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 95"
          aria-hidden="true"
          preserveAspectRatio="xMidYMid meet"
        >
          <path
            d="M8 72 H24 V30 H46 V56 H66 V22 H86 V72"
            fill="none"
            stroke="rgb(249 115 22 / 0.32)"
            strokeDasharray="1.5 3"
            strokeLinecap="round"
            strokeWidth="1.6"
          />
          <path
            d="M12 86 H40 M52 86 H82 M14 10 H38 M52 10 H82"
            fill="none"
            stroke="rgb(63 63 70 / 0.55)"
            strokeLinecap="round"
            strokeWidth="3"
          />
          {dots.map((dot) => (
            <circle
              key={dot.progress}
              cx={dot.x}
              cy={dot.y}
              r="1.4"
              fill="rgb(253 224 71 / 0.85)"
              opacity={percent >= dot.progress ? 0.18 : 1}
            />
          ))}
        </svg>
        <div className="otl-ghost" style={{ left: `${ghostThree.x}%`, top: `${ghostThree.y}%` }}>
          <GhostSvg color="#22d3ee" />
        </div>
        <div className="otl-ghost" style={{ left: `${ghostTwo.x}%`, top: `${ghostTwo.y}%` }}>
          <GhostSvg color="#f472b6" />
        </div>
        <div className="otl-ghost" style={{ left: `${ghostOne.x}%`, top: `${ghostOne.y}%` }}>
          <GhostSvg color="#a855f7" />
        </div>
        <div
          className="absolute z-10 h-7 w-7 -translate-x-1/2 -translate-y-1/2 transition-all duration-500 ease-out"
          style={{ left: `${pacman.x}%`, top: `${pacman.y}%` }}
        >
          <PacmanSvg gradientId={`otl-pac-${gradientId}`} />
        </div>
        <div className="absolute bottom-2 right-3 rounded-full border border-orange-500/30 bg-zinc-950/80 px-2 py-0.5 font-mono text-xs text-orange-200">
          {Math.round(percent)}%
        </div>
      </div>
      <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className="h-full rounded-full bg-orange-500 transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

// ─── QueueCard ────────────────────────────────────────────────────────────────

function QueueCard({
  item,
  fps,
  mode,
  onRemove,
  onDownload,
}: {
  item: QueueItem;
  fps: number;
  mode: PipelineMode;
  onRemove: () => void;
  onDownload: (item: QueueItem, type: "video" | "zip") => void;
}) {
  const [showRejected, setShowRejected] = useState(false);
  const analyzePct = item.files.length ? (item.analyzed / item.files.length) * 100 : 0;
  const motionPct = item.motionTotal ? (item.motionDone / item.motionTotal) * 100 : 0;
  const encodePct = item.encodeTotal ? (item.encodeCurrent / item.encodeTotal) * 100 : 0;

  return (
    <div
      className={`rounded-2xl border bg-zinc-900 overflow-hidden transition-all ${
        item.status === "processing"
          ? "border-orange-500/40"
          : item.status === "done"
            ? "border-green-700/40"
            : item.status === "error"
              ? "border-red-700/40"
              : "border-zinc-800"
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            item.status === "processing"
              ? "bg-orange-500/20"
              : item.status === "done"
                ? "bg-green-500/20"
                : item.status === "error"
                  ? "bg-red-500/20"
                  : "bg-zinc-800"
          }`}
        >
          {item.status === "processing" && (
            <Loader2 className="h-4 w-4 animate-spin text-orange-400" />
          )}
          {item.status === "done" && <CheckCircle2 className="h-4 w-4 text-green-400" />}
          {item.status === "error" && <AlertCircle className="h-4 w-4 text-red-400" />}
          {item.status === "pending" && <ListVideo className="h-4 w-4 text-zinc-400" />}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{item.label}</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            {item.files.length.toLocaleString("pt-BR")} fotos
            {item.camera && <span className="ml-1 text-zinc-600">· {item.camera}</span>}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {item.status === "processing" && (
            <span className="font-mono text-xs text-zinc-400 tabular-nums bg-zinc-800 px-2 py-0.5 rounded">
              {fmtTime(item.elapsed)}
            </span>
          )}
          {item.status === "pending" && (
            <button
              onClick={onRemove}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Processing progress */}
      {item.status === "processing" && (
        <div className="px-5 pb-4 space-y-3">
          {(item.phase === "analyzing" || item.phase !== "idle") && (
            <ProgressBar
              label={item.phase === "analyzing" ? "Analisando frames" : "✓ Análise concluída"}
              sublabel={`${item.analyzed.toLocaleString("pt-BR")} / ${item.files.length.toLocaleString("pt-BR")}${item.rejectedCount > 0 ? ` · ${item.rejectedCount} descartados` : ""}`}
              value={analyzePct}
            />
          )}
          {item.motionTotal > 0 && (
            <ProgressBar
              label={
                item.phase === "motion" ? "Detectando inatividade…" : "✓ Detecção de movimento"
              }
              sublabel={`${item.motionDone} / ${item.motionTotal}`}
              value={motionPct}
            />
          )}
          {mode === "video" && (item.phase === "encoding" || item.encodeCurrent > 0) && (
            <ProgressBar
              label={ENCODE_LABELS[item.encodePhase]}
              sublabel={`${item.encodeCurrent.toLocaleString("pt-BR")} / ${item.encodeTotal.toLocaleString("pt-BR")}`}
              value={encodePct}
            />
          )}
        </div>
      )}

      {/* Done result */}
      {item.status === "done" && item.result && (
        <div className="px-5 pb-4 space-y-3">
          {/* Video preview */}
          {item.result.videoUrl && (
            <video
              src={item.result.videoUrl}
              controls
              className="w-full rounded-xl bg-black aspect-video"
            />
          )}

          {/* Stats */}
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { label: "Total", val: item.result.totalCount, color: "text-white" },
              { label: "Utilizadas", val: item.result.usedCount, color: "text-green-400" },
              { label: "Descartadas", val: item.result.rejected.length, color: "text-red-400" },
            ].map(({ label, val, color }) => (
              <div key={label} className="rounded-lg bg-zinc-800/60 py-2">
                <p className={`text-lg font-bold ${color}`}>{val.toLocaleString("pt-BR")}</p>
                <p className="text-xs text-zinc-500">{label}</p>
              </div>
            ))}
          </div>

          {/* Suggested name */}
          <div className="rounded-lg bg-zinc-800/40 px-3 py-2 flex items-center gap-2">
            <span className="text-xs text-zinc-500 shrink-0">Nome sugerido:</span>
            <span className="text-xs text-zinc-200 font-mono truncate">
              {item.result.suggestedName}
            </span>
          </div>

          {/* Download buttons */}
          <div className="flex gap-2 flex-wrap">
            {item.result.videoBlob && (
              <Button
                onClick={() => onDownload(item, "video")}
                className="flex-1 bg-orange-500 hover:bg-orange-400 text-white font-semibold shadow-lg shadow-orange-500/20"
              >
                <Download className="mr-2 h-4 w-4" /> Baixar MP4 · {fmt(item.result.size)}
              </Button>
            )}
            {item.result.zipBlob && (
              <Button
                onClick={() => onDownload(item, "zip")}
                className="flex-1 bg-orange-500 hover:bg-orange-400 text-white font-semibold shadow-lg shadow-orange-500/20"
              >
                <Download className="mr-2 h-4 w-4" /> Baixar ZIP · {fmt(item.result.size)}
              </Button>
            )}
          </div>

          {/* Rejected gallery toggle */}
          {item.result.rejected.length > 0 && (
            <button
              onClick={() => setShowRejected((v) => !v)}
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {showRejected ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              {item.result.rejected.length} frames descartados
            </button>
          )}
          {showRejected && item.result.rejected.length > 0 && (
            <div className="grid grid-cols-4 gap-2">
              {item.result.rejected.slice(0, 12).map((r) => (
                <div
                  key={r.index}
                  className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-800/50"
                >
                  {r.thumb ? (
                    <img src={r.thumb} alt={r.name} className="h-14 w-full object-cover" />
                  ) : (
                    <div className="flex h-14 items-center justify-center text-xs text-zinc-600">
                      N/A
                    </div>
                  )}
                  <div className="px-1.5 py-1 text-xs">
                    <p className="truncate text-zinc-400">{r.reason}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {item.status === "error" && (
        <div className="px-5 pb-4">
          <p className="text-xs text-red-400 leading-relaxed">{item.error}</p>
        </div>
      )}
    </div>
  );
}

type StabilizerResult = {
  videoBlob: Blob;
  videoUrl: string;
  size: number;
  frameCount: number;
  suggestedName: string;
  maxShift: number;
};

function StabilizerPanel() {
  const [files, setFiles] = useState<File[]>([]);
  const [resolution, setResolution] = useState<ResolutionKey>("1080p");
  const [fps, setFps] = useState<number>(24);
  const [smoothingWindow, setSmoothingWindow] = useState(25);
  const [cropPercent, setCropPercent] = useState(6);
  const [phase, setPhase] = useState<StabilizerPhase>("loading");
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(1);
  const [isRunning, setIsRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<StabilizerResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onDrop = useCallback(
    (accepted: File[]) => {
      const supported = accepted.filter((f) => /\.(jpe?g|png|zip)$/i.test(f.name));
      const videos = accepted.filter((f) => /\.mp4$/i.test(f.name));
      setError(
        videos.length > 0
          ? "MP4 direto fica para a próxima versão. Envie uma sequência JPG/PNG ou um ZIP com imagens."
          : null,
      );
      if (supported.length === 0) return;
      setFiles((prev) => [...prev, ...supported].sort((a, b) => a.name.localeCompare(b.name)));
      if (result?.videoUrl) URL.revokeObjectURL(result.videoUrl);
      setResult(null);
    },
    [result?.videoUrl],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "image/jpeg": [".jpg", ".jpeg"],
      "image/png": [".png"],
      "application/zip": [".zip"],
      "video/mp4": [".mp4"],
    },
    multiple: true,
  });

  const progress = total > 0 ? (current / total) * 100 : 0;
  const res = RESOLUTIONS[resolution];

  const runStabilizer = async () => {
    if (isRunning || files.length === 0) return;
    setIsRunning(true);
    setError(null);
    setLogs([]);
    setElapsed(0);
    if (result?.videoUrl) URL.revokeObjectURL(result.videoUrl);
    setResult(null);

    const startedAt = performance.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((performance.now() - startedAt) / 1000));
    }, 500);

    await runStabilizerPipeline(
      files,
      {
        onProgress: (p, c, t) => {
          setPhase(p);
          setCurrent(c);
          setTotal(t);
        },
        onLog: (message) => {
          setLogs((prev) => [...prev, message]);
        },
        onDone: (res) => {
          clearInterval(timer);
          setIsRunning(false);
          setResult(res);
          setLogs((prev) => [...prev, "Vídeo estabilizado pronto para download."]);
        },
        onError: (message) => {
          clearInterval(timer);
          setIsRunning(false);
          setError(message);
        },
      },
      {
        fps,
        width: res.width,
        height: res.height,
        bitrate: res.bitrate,
        smoothingWindow,
        cropPercent: cropPercent / 100,
      },
    );
  };

  const clearAll = () => {
    if (result?.videoUrl) URL.revokeObjectURL(result.videoUrl);
    setFiles([]);
    setResult(null);
    setError(null);
    setLogs([]);
    setElapsed(0);
  };

  const handleDownload = async () => {
    if (!result) return;
    await saveFile(result.videoBlob, result.suggestedName, "mp4");
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-orange-400">
              <Wand2 className="h-4 w-4" />
              <p className="text-xs font-semibold uppercase tracking-widest">
                OTL Timelapse Stabilizer
              </p>
            </div>
            <h2 className="mt-2 text-xl font-bold text-white">
              Estabilização digital para câmera fixa
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-400">
              Corrige tremores leves de obra causados por vento, vibração ou suporte instável. Esta
              primeira versão trabalha com sequências JPG/PNG ou ZIP de imagens.
            </p>
          </div>
          {files.length > 0 && (
            <Button
              variant="ghost"
              onClick={clearAll}
              disabled={isRunning}
              className="text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <Trash2 className="mr-2 h-4 w-4" /> Limpar
            </Button>
          )}
        </div>
      </div>

      <div
        {...getRootProps()}
        className={`relative cursor-pointer rounded-2xl border-2 border-dashed p-10 text-center transition-all duration-200 ${
          isDragActive
            ? "border-orange-400 bg-orange-500/10 scale-[1.01]"
            : "border-zinc-700 bg-zinc-900 hover:border-zinc-500 hover:bg-zinc-800/60"
        }`}
      >
        <input {...getInputProps()} />
        <div className="flex flex-col items-center gap-3">
          <div
            className={`flex h-14 w-14 items-center justify-center rounded-2xl transition-colors ${isDragActive ? "bg-orange-500/20" : "bg-zinc-800"}`}
          >
            <Images className={`h-6 w-6 ${isDragActive ? "text-orange-400" : "text-zinc-400"}`} />
          </div>
          <div>
            <p className="text-lg font-semibold text-zinc-100">
              {isDragActive
                ? "Solte os arquivos aqui"
                : files.length > 0
                  ? "Adicionar mais frames"
                  : "Arraste uma sequência de imagens ou ZIP"}
            </p>
            <p className="mt-1 text-sm text-zinc-500">
              JPG, PNG ou ZIP · MP4 direto será tratado em uma versão avançada
            </p>
          </div>
        </div>
      </div>

      {files.length > 0 && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5 space-y-5">
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-zinc-800/60 p-3 text-center">
              <p className="text-xl font-bold text-white">{files.length.toLocaleString("pt-BR")}</p>
              <p className="mt-0.5 text-xs text-zinc-400">arquivos selecionados</p>
            </div>
            <div className="rounded-xl bg-zinc-800/60 p-3 text-center">
              <p className="text-xl font-bold text-white">{res.label.replace(" — ", " ")}</p>
              <p className="mt-0.5 text-xs text-zinc-400">resolução de saída</p>
            </div>
            <div className="rounded-xl bg-zinc-800/60 p-3 text-center">
              <p className="text-xl font-bold text-white">≈ {Math.round(files.length / fps)}s</p>
              <p className="mt-0.5 text-xs text-zinc-400">duração estimada</p>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-800/30 p-4 space-y-4">
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-400 uppercase tracking-widest">
              <Settings2 className="h-3.5 w-3.5" /> Configurações do estabilizador
            </div>
            <ToggleGroup
              label="Resolução"
              options={Object.entries(RESOLUTIONS).map(([k, v]) => ({
                value: k as ResolutionKey,
                label: v.label,
              }))}
              value={resolution}
              onChange={(v) => setResolution(v as ResolutionKey)}
              disabled={isRunning}
            />
            <ToggleGroup
              label="FPS"
              options={FPS_OPTIONS.map((o) => ({ value: o.value, label: o.label, note: o.note }))}
              value={fps}
              onChange={(v) => setFps(v as number)}
              disabled={isRunning}
            />
            <div className="flex flex-wrap gap-4">
              <NumberInput
                label="Suavização"
                value={smoothingWindow}
                onChange={setSmoothingWindow}
                min={5}
                max={80}
                unit="frames"
              />
              <NumberInput
                label="Crop extra"
                value={cropPercent}
                onChange={setCropPercent}
                min={2}
                max={15}
                unit="%"
              />
            </div>
          </div>

          {isRunning && (
            <div className="space-y-3 rounded-xl border border-orange-500/30 bg-orange-500/5 p-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-zinc-400 tabular-nums">
                  {fmtTime(elapsed)}
                </span>
                <Loader2 className="h-4 w-4 animate-spin text-orange-400" />
              </div>
              <ProgressBar
                label={STABILIZER_PHASE_LABELS[phase]}
                sublabel={`${current.toLocaleString("pt-BR")} / ${total.toLocaleString("pt-BR")}`}
                value={progress}
              />
            </div>
          )}

          {logs.length > 0 && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-widest text-zinc-500">
                Logs
              </p>
              <div className="space-y-1 font-mono text-xs text-zinc-400">
                {logs.slice(-6).map((log, idx) => (
                  <p key={`${log}-${idx}`}>› {log}</p>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {result && (
            <div className="space-y-3 rounded-xl border border-green-700/40 bg-zinc-900 p-4">
              <video
                src={result.videoUrl}
                controls
                className="w-full rounded-xl bg-black aspect-video"
              />
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-zinc-800/60 py-2">
                  <p className="text-lg font-bold text-white">
                    {result.frameCount.toLocaleString("pt-BR")}
                  </p>
                  <p className="text-xs text-zinc-500">frames</p>
                </div>
                <div className="rounded-lg bg-zinc-800/60 py-2">
                  <p className="text-lg font-bold text-orange-400">
                    {result.maxShift.toFixed(1)}px
                  </p>
                  <p className="text-xs text-zinc-500">correção máx.</p>
                </div>
                <div className="rounded-lg bg-zinc-800/60 py-2">
                  <p className="text-lg font-bold text-green-400">{fmt(result.size)}</p>
                  <p className="text-xs text-zinc-500">arquivo</p>
                </div>
              </div>
              <Button
                onClick={handleDownload}
                className="w-full bg-orange-500 hover:bg-orange-400 text-white font-semibold shadow-lg shadow-orange-500/20"
              >
                <Download className="mr-2 h-4 w-4" /> Baixar MP4 estabilizado
              </Button>
            </div>
          )}

          <div className="flex justify-end">
            <Button
              onClick={runStabilizer}
              disabled={isRunning || files.length === 0}
              className="bg-orange-500 hover:bg-orange-400 text-white font-semibold px-6 shadow-lg shadow-orange-500/20 disabled:opacity-50"
            >
              {isRunning ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Estabilizando…
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Estabilizar timelapse
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {files.length === 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            {
              icon: ShieldCheck,
              title: "100% local",
              desc: "As imagens continuam no navegador de quem está processando.",
            },
            {
              icon: Activity,
              title: "Câmera fixa",
              desc: "O MVP corrige tremor leve por deslocamento horizontal/vertical.",
            },
            {
              icon: RotateCcw,
              title: "Antes do MP4",
              desc: "Use sequências de frames já exportadas ou um ZIP com imagens.",
            },
          ].map(({ icon: Icon, title, desc }) => (
            <div key={title} className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800 mb-3">
                <Icon className="h-4 w-4 text-orange-400" />
              </div>
              <p className="font-semibold text-sm text-zinc-100">{title}</p>
              <p className="mt-1 text-xs text-zinc-500 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function Index() {
  const [activeTool, setActiveTool] = useState<ActiveTool>("cleaner");
  // ── Config ──
  const [mode, setMode] = useState<PipelineMode>("video");
  const [resolution, setResolution] = useState<ResolutionKey>("1080p");
  const [fps, setFps] = useState<number>(24);
  const [filters, setFilters] = useState<FilterOptions>({ ...DEFAULT_FILTERS });
  const [showFilters, setShowFilters] = useState(false);
  const [importState, setImportState] = useState<ImportState>({
    active: false,
    current: 0,
    total: 1,
    message: "",
  });

  // ── Queue ──
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const activeTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // ── Drop zone ──
  const beginImport = useCallback((message: string) => {
    setImportState({
      active: true,
      current: 0,
      total: 1,
      message,
      indeterminate: true,
    });
  }, []);

  const handleAcceptedFiles = useCallback(async (accepted: File[]) => {
    const imgs = accepted.filter((f) => /\.(jpe?g|png)$/i.test(f.name));
    if (imgs.length === 0) {
      setImportState({
        active: false,
        current: 0,
        total: 1,
        message: "",
        indeterminate: false,
      });
      return;
    }

    setImportState({
      active: true,
      current: 0,
      total: imgs.length,
      message: `Preparando ${imgs.length.toLocaleString("pt-BR")} fotos...`,
      indeterminate: false,
    });
    await waitForPaint();

    const groups = groupFilesByCamera(imgs);
    const entries = [...groups.entries()];

    const queueItems = entries.map(([key, files], idx) => {
      const [camera, project] = key === "__misc__" ? ["", ""] : key.split("|||");
      setImportState({
        active: true,
        current: idx + 1,
        total: entries.length,
        message: `Organizando lote ${idx + 1} de ${entries.length}...`,
        indeterminate: false,
      });
      return makeQueueItem(camera, project, files);
    });

    setQueue((prev) => [...prev, ...queueItems]);
    await waitForPaint();

    setImportState({
      active: false,
      current: entries.length,
      total: entries.length || 1,
      message: "",
      indeterminate: false,
    });
  }, []);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop: handleAcceptedFiles,
    accept: { "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"] },
    multiple: true,
    noClick: true,
  });

  const dropzoneProps = getRootProps();
  const dropzoneRootProps = {
    ...dropzoneProps,
    onDropCapture: (event: React.DragEvent<HTMLDivElement>) => {
      const items = event.dataTransfer?.items;
      const hasFiles =
        (items && Array.from(items).some((it) => it.kind === "file")) ||
        (event.dataTransfer?.files?.length ?? 0) > 0;
      if (hasFiles) {
        beginImport("Lendo arquivos da pasta...");
      }
      dropzoneProps.onDropCapture?.(event);
    },
  };

  const handleFolderInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const target = event.target;
    const fileList = target.files;
    if (!fileList || fileList.length === 0) return;
    beginImport("Lendo arquivos selecionados...");
    await waitForPaint();
    const selected = Array.from(fileList);
    target.value = "";
    await handleAcceptedFiles(selected);
  };

  // ── Queue helpers ──
  const pendingItems = queue.filter((i) => i.status === "pending");
  const doneItems = queue.filter((i) => i.status === "done");
  const errorItems = queue.filter((i) => i.status === "error");
  const processingItem = queue.find((i) => i.status === "processing");

  const removeItem = (id: string) => setQueue((q) => q.filter((i) => i.id !== id));

  const clearDone = () => {
    setQueue((q) => {
      q.filter((i) => i.status === "done" || i.status === "error").forEach((i) => {
        if (i.result?.videoUrl) URL.revokeObjectURL(i.result.videoUrl);
        if (i.result?.zipUrl) URL.revokeObjectURL(i.result.zipUrl);
      });
      return q.filter((i) => i.status !== "done" && i.status !== "error");
    });
  };

  const updateItem = (id: string, patch: Partial<QueueItem>) => {
    setQueue((q) => q.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  };

  // ── Download ──
  const handleDownload = async (item: QueueItem, type: "video" | "zip") => {
    if (!item.result) return;
    const blob = type === "video" ? item.result.videoBlob : item.result.zipBlob;
    if (!blob) return;
    await saveFile(blob, item.result.suggestedName, type === "video" ? "mp4" : "zip");
  };

  // ── Process queue ──
  const processQueue = async () => {
    if (isRunning) return;
    setIsRunning(true);

    const res = RESOLUTIONS[resolution];
    const cfg = {
      mode,
      fps,
      width: res.width,
      height: res.height,
      bitrate: res.bitrate,
      filters: { ...filters },
    };

    // Process pending items one at a time
    const pending = queue.filter((i) => i.status === "pending");

    for (const item of pending) {
      // Set up elapsed timer
      const startedAt = performance.now();
      const timer = setInterval(() => {
        updateItem(item.id, { elapsed: Math.floor((performance.now() - startedAt) / 1000) });
      }, 500);
      activeTimers.current.set(item.id, timer);

      updateItem(item.id, { status: "processing", phase: "analyzing" });

      await new Promise<void>((resolve) => {
        runPipeline(
          item.files,
          {
            onAnalyzeProgress: (done, _total, rejected) => {
              updateItem(item.id, { analyzed: done, rejectedCount: rejected, phase: "analyzing" });
            },
            onMotionProgress: (done, total) => {
              updateItem(item.id, { phase: "motion", motionDone: done, motionTotal: total });
            },
            onEncodeProgress: (p, current, total) => {
              updateItem(item.id, {
                phase: "encoding",
                encodePhase: p as EncodePhase,
                encodeCurrent: current,
                encodeTotal: total,
              });
            },
            onZipProgress: (current, total) => {
              updateItem(item.id, { phase: "zipping", encodeCurrent: current, encodeTotal: total });
            },
            onDone: (res) => {
              clearInterval(timer);
              activeTimers.current.delete(item.id);
              updateItem(item.id, { status: "done", phase: "done", result: res });
              resolve();
            },
            onError: (msg) => {
              clearInterval(timer);
              activeTimers.current.delete(item.id);
              updateItem(item.id, { status: "error", error: msg });
              resolve();
            },
          },
          cfg,
        ).catch((e) => {
          clearInterval(timer);
          activeTimers.current.delete(item.id);
          updateItem(item.id, { status: "error", error: e.message ?? String(e) });
          resolve();
        });
      });
    }

    setIsRunning(false);
  };

  // ── UI state flags ──
  const hasPending = pendingItems.length > 0;
  const hasQueue = queue.length > 0;
  const totalFiles = useMemo(
    () => pendingItems.reduce((s, i) => s + i.files.length, 0),
    [pendingItems],
  );
  const totalEstSecs = Math.round(totalFiles / fps);

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="mx-auto max-w-5xl px-6 py-4 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-500 shadow-lg shadow-orange-500/30">
            <Film className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight text-white">
              {activeTool === "cleaner" ? "OTL — ObrasTimeLapse" : "OTL — Timelapse Stabilizer"}
            </h1>
            <p className="text-xs text-zinc-400">
              {activeTool === "cleaner"
                ? "Limpeza automática de frames · 4K / 1080p · Fila de câmeras"
                : "Estabilização digital para timelapse de obras"}
            </p>
          </div>
          {activeTool === "cleaner" && hasQueue && (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-zinc-500 tabular-nums">
                {queue.length} {queue.length === 1 ? "item" : "itens"} na fila
              </span>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8 space-y-6">
        <div className="grid grid-cols-2 gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-2">
          {(
            [
              {
                id: "cleaner" as ActiveTool,
                Icon: Film,
                title: "Criar Timelapse",
                sub: "Limpar frames e exportar MP4/ZIP",
                disabled: false,
              },
              {
                id: "stabilizer" as ActiveTool,
                Icon: Wand2,
                title: "Estabilizador",
                sub: "Em breve",
                disabled: true,
              },
            ] as const
          ).map(({ id, Icon, title, sub, disabled }) => (
            <button
              key={id}
              disabled={disabled}
              onClick={() => {
                if (!disabled) setActiveTool(id);
              }}
              className={`flex items-center gap-3 rounded-xl border p-4 text-left transition-all ${
                disabled
                  ? "cursor-not-allowed border-zinc-800 bg-zinc-950/70 text-zinc-600 opacity-70"
                  : activeTool === id
                    ? "border-orange-500 bg-orange-500/10 text-white"
                    : "border-transparent bg-zinc-800/30 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              }`}
            >
              <Icon
                className={`h-5 w-5 shrink-0 ${
                  disabled ? "text-zinc-700" : activeTool === id ? "text-orange-400" : ""
                }`}
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold">{title}</p>
                  {disabled && (
                    <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                      Em breve
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs opacity-70">{sub}</p>
              </div>
            </button>
          ))}
        </div>

        {activeTool === "cleaner" ? (
          <>
            {/* ── Drop zone ── */}
            <div
              {...dropzoneRootProps}
              className={`relative cursor-pointer rounded-2xl border-2 border-dashed p-12 text-center transition-all duration-200 ${
                isDragActive
                  ? "border-orange-400 bg-orange-500/10 scale-[1.01]"
                  : "border-zinc-700 bg-zinc-900 hover:border-zinc-500 hover:bg-zinc-800/60"
              }`}
            >
              <input {...getInputProps()} />
              <input
                ref={folderInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFolderInput}
                {...({
                  webkitdirectory: "",
                  directory: "",
                } as React.InputHTMLAttributes<HTMLInputElement> & {
                  webkitdirectory: string;
                  directory: string;
                })}
              />
              <div className="flex flex-col items-center gap-3">
                <div
                  className={`flex h-14 w-14 items-center justify-center rounded-2xl transition-colors ${isDragActive ? "bg-orange-500/20" : "bg-zinc-800"}`}
                >
                  <Upload
                    className={`h-6 w-6 ${isDragActive ? "text-orange-400" : "text-zinc-400"}`}
                  />
                </div>
                <div>
                  <p className="text-lg font-semibold text-zinc-100">
                    {isDragActive
                      ? "Solte as fotos aqui"
                      : hasQueue
                        ? "Adicionar mais fotos à fila"
                        : "Arraste as fotos ou clique para selecionar"}
                  </p>
                  <p className="mt-1 text-sm text-zinc-500">
                    JPG ou PNG · arraste uma pasta ou selecione pelos botões abaixo
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-2 pt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      open();
                    }}
                    className="border border-zinc-700 bg-zinc-800/70 text-zinc-200 hover:bg-zinc-800"
                  >
                    <Upload className="mr-2 h-4 w-4" /> Selecionar fotos
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      folderInputRef.current?.click();
                    }}
                    className="border border-orange-500/30 bg-orange-500/10 text-orange-100 hover:bg-orange-500/20"
                  >
                    <FolderOpen className="mr-2 h-4 w-4" /> Selecionar pasta inteira
                  </Button>
                </div>
              </div>
            </div>

            {importState.active && (
              <div className="rounded-2xl border border-orange-500/30 bg-orange-500/5 p-4">
                {importState.indeterminate ? (
                  <IndeterminateLoader
                    label="Lendo arquivos..."
                    message={
                      importState.message ||
                      "Aguarde enquanto o navegador percorre a pasta selecionada"
                    }
                  />
                ) : (
                  <ProgressBar
                    label="Carregando seleção"
                    sublabel={importState.message}
                    value={(importState.current / Math.max(1, importState.total)) * 100}
                  />
                )}
              </div>
            )}

            {/* ── Config + filters (only when there's something to process) ── */}
            {hasPending && (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5 space-y-5">
                {/* Summary */}
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: "fotos na fila", val: totalFiles.toLocaleString("pt-BR") },
                    { label: "câmeras / lotes", val: pendingItems.length.toLocaleString("pt-BR") },
                    { label: "duração estimada", val: `≈ ${totalEstSecs}s` },
                  ].map(({ label, val }) => (
                    <div key={label} className="rounded-xl bg-zinc-800/60 p-3 text-center">
                      <p className="text-xl font-bold text-white">{val}</p>
                      <p className="mt-0.5 text-xs text-zinc-400">{label}</p>
                    </div>
                  ))}
                </div>

                {/* Mode */}
                <div>
                  <p className="text-xs font-medium text-zinc-400 uppercase tracking-widest mb-2">
                    Formato de saída
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {(
                      [
                        {
                          id: "video" as PipelineMode,
                          Icon: Video,
                          title: "Vídeo Timelapse",
                          sub: "MP4 · H.264",
                        },
                        {
                          id: "zip" as PipelineMode,
                          Icon: FolderArchive,
                          title: "Fotos Limpas (ZIP)",
                          sub: "Pasta compactada",
                        },
                      ] as const
                    ).map(({ id, Icon, title, sub }) => (
                      <button
                        key={id}
                        onClick={() => setMode(id)}
                        className={`flex items-center gap-3 rounded-xl border p-4 text-left transition-all ${
                          mode === id
                            ? "border-orange-500 bg-orange-500/10 text-white"
                            : "border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300"
                        }`}
                      >
                        <Icon
                          className={`h-5 w-5 shrink-0 ${mode === id ? "text-orange-400" : ""}`}
                        />
                        <div>
                          <p className="font-semibold text-sm">{title}</p>
                          <p className="text-xs opacity-70 mt-0.5">{sub}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Video options */}
                {mode === "video" && (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-800/30 p-4 space-y-4">
                    <div className="flex items-center gap-2 text-xs font-medium text-zinc-400 uppercase tracking-widest">
                      <Settings2 className="h-3.5 w-3.5" /> Configurações do vídeo
                    </div>
                    <ToggleGroup
                      label="Resolução"
                      options={Object.entries(RESOLUTIONS).map(([k, v]) => ({
                        value: k as ResolutionKey,
                        label: v.label,
                      }))}
                      value={resolution}
                      onChange={(v) => setResolution(v as ResolutionKey)}
                    />
                    <ToggleGroup
                      label="Velocidade (FPS)"
                      options={FPS_OPTIONS.map((o) => ({
                        value: o.value,
                        label: o.label,
                        note: o.note,
                      }))}
                      value={fps}
                      onChange={(v) => setFps(v as number)}
                    />
                  </div>
                )}

                {/* Advanced filters */}
                <div className="rounded-xl border border-zinc-800 bg-zinc-800/20">
                  <button
                    onClick={() => setShowFilters((v) => !v)}
                    className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-zinc-300 hover:text-white transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <Settings2 className="h-4 w-4 text-zinc-500" />
                      Filtros avançados
                      {(filters.filterNight || filters.filterHours || filters.filterInactive) && (
                        <span className="rounded-full bg-orange-500 px-1.5 py-0.5 text-xs text-white font-semibold">
                          {
                            [
                              filters.filterNight,
                              filters.filterHours,
                              filters.filterInactive,
                            ].filter(Boolean).length
                          }{" "}
                          ativos
                        </span>
                      )}
                    </div>
                    {showFilters ? (
                      <ChevronUp className="h-4 w-4 text-zinc-500" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-zinc-500" />
                    )}
                  </button>

                  {showFilters && (
                    <div className="border-t border-zinc-800 p-4 space-y-3">
                      <p className="text-xs text-zinc-500 leading-relaxed">
                        Filtros extras além da detecção de defeitos padrão. Aplique conforme
                        necessário.
                      </p>

                      <FilterToggle
                        icon={Moon}
                        title="Excluir fotos noturnas"
                        desc="Remove fotos com baixo brilho médio, típicas de noites sem iluminação na obra."
                        checked={filters.filterNight}
                        onChange={(v) => setFilters((f) => ({ ...f, filterNight: v }))}
                      />
                      {filters.filterNight && (
                        <div className="pl-10">
                          <NumberInput
                            label="Limiar de brilho"
                            value={filters.nightThreshold}
                            onChange={(v) => setFilters((f) => ({ ...f, nightThreshold: v }))}
                            min={19}
                            max={100}
                            unit="(0–100, padrão 50)"
                          />
                        </div>
                      )}

                      <FilterToggle
                        icon={Clock}
                        title="Excluir fora do horário de obra"
                        desc="Remove fotos tiradas antes das 08h ou após as 17h (lê o horário do nome do arquivo)."
                        checked={filters.filterHours}
                        onChange={(v) => setFilters((f) => ({ ...f, filterHours: v }))}
                      />
                      {filters.filterHours && (
                        <div className="pl-10 flex flex-wrap gap-4">
                          <NumberInput
                            label="Início do turno"
                            value={filters.workStart}
                            onChange={(v) => setFilters((f) => ({ ...f, workStart: v }))}
                            min={0}
                            max={23}
                            unit="h"
                          />
                          <NumberInput
                            label="Fim do turno"
                            value={filters.workEnd}
                            onChange={(v) => setFilters((f) => ({ ...f, workEnd: v }))}
                            min={1}
                            max={24}
                            unit="h"
                          />
                        </div>
                      )}

                      <FilterToggle
                        icon={Activity}
                        title="Excluir sem movimentação"
                        desc="Compara frames consecutivos e remove os muito similares (sem pessoas, máquinas ou movimento)."
                        checked={filters.filterInactive}
                        onChange={(v) => setFilters((f) => ({ ...f, filterInactive: v }))}
                      />
                      {filters.filterInactive && (
                        <div className="pl-10">
                          <NumberInput
                            label="Sensibilidade"
                            value={filters.inactiveThreshold}
                            onChange={(v) => setFilters((f) => ({ ...f, inactiveThreshold: v }))}
                            min={1}
                            max={30}
                            unit="(1 = muito sensível, 30 = só se totalmente parado)"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-3 justify-end pt-1">
                  <Button
                    variant="ghost"
                    className="text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                    onClick={() => setQueue((q) => q.filter((i) => i.status !== "pending"))}
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Limpar pendentes
                  </Button>
                  <Button
                    onClick={processQueue}
                    disabled={isRunning || !hasPending}
                    className="bg-orange-500 hover:bg-orange-400 text-white font-semibold px-6 shadow-lg shadow-orange-500/20 disabled:opacity-50"
                  >
                    {isRunning ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Processando…
                      </>
                    ) : (
                      <>
                        <Play className="mr-2 h-4 w-4" />
                        Processar fila ({pendingItems.length})
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}

            {/* ── Queue list ── */}
            {hasQueue && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
                    <ListVideo className="h-4 w-4 text-zinc-500" />
                    Fila de processamento
                  </h2>
                  {(doneItems.length > 0 || errorItems.length > 0) && (
                    <button
                      onClick={clearDone}
                      className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1"
                    >
                      <Trash2 className="h-3 w-3" /> Limpar concluídos
                    </button>
                  )}
                </div>

                <div className="space-y-3">
                  {/* Processing / done / error first, then pending */}
                  {[...queue]
                    .sort((a, b) => {
                      const order = { processing: 0, done: 1, error: 2, pending: 3 };
                      return order[a.status] - order[b.status];
                    })
                    .map((item) => (
                      <QueueCard
                        key={item.id}
                        item={item}
                        fps={fps}
                        mode={mode}
                        onRemove={() => removeItem(item.id)}
                        onDownload={handleDownload}
                      />
                    ))}
                </div>
              </div>
            )}

            {/* ── Empty state ── */}
            {!hasQueue && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[
                  {
                    icon: ShieldCheck,
                    title: "100% local",
                    desc: "Nenhuma foto é enviada para servidores. Tudo roda no seu navegador.",
                  },
                  {
                    icon: Zap,
                    title: "Multi-câmera",
                    desc: "Arraste fotos de várias câmeras de uma vez — o sistema agrupa automaticamente por câmera e obra.",
                  },
                  {
                    icon: Plus,
                    title: "Fila inteligente",
                    desc: "Processa lotes em sequência. Baixe cada timelapse com nome gerado automaticamente (câmera + mês + ano).",
                  },
                ].map(({ icon: Icon, title, desc }) => (
                  <div key={title} className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800 mb-3">
                      <Icon className="h-4 w-4 text-orange-400" />
                    </div>
                    <p className="font-semibold text-sm text-zinc-100">{title}</p>
                    <p className="mt-1 text-xs text-zinc-500 leading-relaxed">{desc}</p>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <StabilizerPanel />
        )}
      </main>
    </div>
  );
}
