import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { zipSync } from "fflate";
import type { DetectorRequest, DetectorResponse } from "@/workers/detector.worker";

// ─── Public types ─────────────────────────────────────────────────────────────

export type RejectedFrame = {
  name: string;
  index: number;
  reason: string;
  deadRatio: number;
  thumb?: string;
};

export type EncodePhase = "loading" | "writing" | "encoding" | "concatenating";
export type PipelineMode = "video" | "zip";

export type FilterOptions = {
  filterNight: boolean;
  nightThreshold: number; // mean brightness 0-100, default 50
  filterHours: boolean;
  workStart: number; // 0-23, default 8
  workEnd: number; // 0-23, default 17
  filterInactive: boolean;
  inactiveThreshold: number; // avg pixel diff 0-30, default 6
};

export const DEFAULT_FILTERS: FilterOptions = {
  filterNight: false,
  nightThreshold: 50,
  filterHours: false,
  workStart: 8,
  workEnd: 17,
  filterInactive: false,
  inactiveThreshold: 6,
};

export type PipelineConfig = {
  fps: number;
  width: number;
  height: number;
  bitrate: number;
  mode: PipelineMode;
  filters: FilterOptions;
};

export type PipelineCallbacks = {
  onAnalyzeProgress: (done: number, total: number, rejectedSoFar: number) => void;
  onMotionProgress?: (done: number, total: number) => void;
  onEncodeProgress: (phase: EncodePhase, current: number, total: number) => void;
  onZipProgress?: (current: number, total: number) => void;
  onDone: (result: {
    videoBlob?: Blob;
    zipBlob?: Blob;
    videoUrl?: string;
    zipUrl?: string;
    size: number;
    rejected: RejectedFrame[];
    usedCount: number;
    totalCount: number;
    suggestedName: string;
  }) => void;
  onError: (message: string) => void;
};

// ─── Resolution & FPS presets ────────────────────────────────────────────────

export const RESOLUTIONS = {
  "1080p": { width: 1920, height: 1080, bitrate: 12_000_000, label: "Full HD — 1080p" },
  "4k": { width: 3840, height: 2160, bitrate: 50_000_000, label: "Ultra HD — 4K" },
} as const;

export type ResolutionKey = keyof typeof RESOLUTIONS;

export const FPS_OPTIONS = [
  { value: 15, label: "15 fps", note: "Bem lento" },
  { value: 20, label: "20 fps", note: "Lento" },
  { value: 24, label: "24 fps", note: "Padrão GlueMotion" },
  { value: 30, label: "30 fps", note: "Rápido" },
] as const;

export type FpsValue = (typeof FPS_OPTIONS)[number]["value"];

// ─── Filename parsing ─────────────────────────────────────────────────────────
// Expected format: "S 63 Montreal_00_20260404082825.jpg"
//  → camera = "S 63", project = "Montreal", datetime = "20260404082825"

export type FilenameInfo = {
  camera: string;
  project: string;
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
};

const MONTHS_PT = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];
const MONTHS_PT_SHORT = [
  "Jan",
  "Fev",
  "Mar",
  "Abr",
  "Mai",
  "Jun",
  "Jul",
  "Ago",
  "Set",
  "Out",
  "Nov",
  "Dez",
];

export function parseFilenameInfo(name: string): FilenameInfo | null {
  const basename = name.replace(/\.[^.]+$/, "");
  const parts = basename.split("_");
  if (parts.length < 2) return null;

  const datetime = parts[parts.length - 1];
  if (!datetime || !/^\d{14}$/.test(datetime)) return null;

  const year = parseInt(datetime.substring(0, 4), 10);
  const month = parseInt(datetime.substring(4, 6), 10);
  const day = parseInt(datetime.substring(6, 8), 10);
  const hour = parseInt(datetime.substring(8, 10), 10);

  const cameraProject = parts[0].trim();
  const words = cameraProject.split(/\s+/);
  let camera = "";
  let project = "";
  if (words.length === 1) {
    camera = words[0];
    project = words[0];
  } else {
    project = words[words.length - 1];
    camera = words.slice(0, -1).join(" ");
  }

  return { camera, project, year, month, day, hour };
}

export function suggestOutputName(files: File[]): {
  camera: string;
  project: string;
  label: string;
} {
  const infos = files.map((f) => parseFilenameInfo(f.name)).filter(Boolean) as FilenameInfo[];

  if (infos.length === 0) return { camera: "Timelapse", project: "", label: "Timelapse" };

  const topCamera = mostCommon(infos.map((i) => i.camera)) ?? "Timelapse";
  const topProject = mostCommon(infos.map((i) => i.project)) ?? "";

  const months = infos.map((i) => i.month);
  const years = infos.map((i) => i.year);
  const minMonth = Math.min(...months);
  const maxMonth = Math.max(...months);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);

  let dateLabel: string;
  if (minYear === maxYear && minMonth === maxMonth) {
    dateLabel = `${MONTHS_PT[minMonth - 1]} ${minYear}`;
  } else if (minYear === maxYear) {
    dateLabel = `${MONTHS_PT_SHORT[minMonth - 1]}-${MONTHS_PT_SHORT[maxMonth - 1]} ${minYear}`;
  } else {
    dateLabel = `${MONTHS_PT_SHORT[minMonth - 1]}${minYear}-${MONTHS_PT_SHORT[maxMonth - 1]}${maxYear}`;
  }

  const label = topCamera ? `${topCamera} - ${dateLabel}` : dateLabel;
  return { camera: topCamera, project: topProject, label };
}

function mostCommon<T>(arr: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Group files by camera (parsed from filename). Falls back to one group if no pattern. */
export function groupFilesByCamera(files: File[]): Map<string, File[]> {
  const groups = new Map<string, File[]>();
  for (const file of files) {
    const info = parseFilenameInfo(file.name);
    // key = "camera|||project" to handle cameras across projects
    const key = info ? `${info.camera}|||${info.project}` : "__misc__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(file);
  }
  return groups;
}

// ─── Save file helper (File System Access API → fallback) ────────────────────

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    createWritable: () => Promise<{
      write: (blob: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};

export async function saveFile(
  blob: Blob,
  suggestedName: string,
  ext: "mp4" | "zip",
): Promise<void> {
  const pickerWindow = window as SaveFilePickerWindow;
  if (pickerWindow.showSaveFilePicker) {
    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: `${suggestedName}.${ext}`,
        types:
          ext === "mp4"
            ? [{ description: "Vídeo MP4", accept: { "video/mp4": [".mp4"] } }]
            : [{ description: "Arquivo ZIP", accept: { "application/zip": [".zip"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return; // user cancelled
      // other error → fall through to legacy download
    }
  }
  // Legacy fallback (Safari, Firefox without flag)
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${suggestedName}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

// ─── Detector workers ─────────────────────────────────────────────────────────

function spawnDetectorWorker() {
  return new Worker(new URL("../workers/detector.worker.ts", import.meta.url), {
    type: "module",
  });
}

async function analyzeAll(
  files: File[],
  cb: PipelineCallbacks,
  filters: FilterOptions,
): Promise<{ accepted: File[]; rejected: RejectedFrame[] }> {
  const total = files.length;
  const concurrency = Math.max(2, Math.min(navigator.hardwareConcurrency ?? 4, 8));
  const workers = Array.from({ length: concurrency }, () => spawnDetectorWorker());
  const results: (DetectorResponse | null)[] = new Array(total).fill(null);
  let nextIndex = 0;
  let done = 0;
  let rejectedCount = 0;

  await new Promise<void>((resolve, reject) => {
    let pending = 0;
    let errored = false;

    const dispatch = (worker: Worker) => {
      if (errored || nextIndex >= total) return;
      const index = nextIndex++;
      pending++;
      const req: DetectorRequest = {
        id: `${index}`,
        index,
        file: files[index],
        filterNight: filters.filterNight,
        nightThreshold: filters.nightThreshold,
        filterHours: filters.filterHours,
        workStart: filters.workStart,
        workEnd: filters.workEnd,
      };
      worker.postMessage(req);
    };

    for (const w of workers) {
      w.onmessage = (e: MessageEvent<DetectorResponse>) => {
        const res = e.data;
        results[res.index] = res;
        done++;
        if (!res.ok) rejectedCount++;
        cb.onAnalyzeProgress(done, total, rejectedCount);
        pending--;
        if (nextIndex < total) dispatch(w);
        else if (pending === 0) resolve();
      };
      w.onerror = (ev) => {
        if (!errored) {
          errored = true;
          reject(new Error(ev.message || "Erro no detector"));
        }
      };
    }

    const initial = Math.min(total, workers.length * 2);
    for (let i = 0; i < initial; i++) dispatch(workers[i % workers.length]);
    if (total === 0) resolve();
  });

  for (const w of workers) w.terminate();

  const accepted: File[] = [];
  const rejected: RejectedFrame[] = [];
  for (let i = 0; i < total; i++) {
    const r = results[i];
    if (!r) continue;
    if (r.ok) accepted.push(files[i]);
    else
      rejected.push({
        name: r.name,
        index: r.index,
        reason: r.reason ?? "Frame defeituoso",
        deadRatio: r.deadRatio,
        thumb: r.thumb,
      });
  }
  return { accepted, rejected };
}

// ─── Motion / inactivity detection (sequential) ───────────────────────────────

const MOTION_W = 64;
const MOTION_H = 64;

async function detectInactive(
  files: File[],
  threshold: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Set<number>> {
  const inactive = new Set<number>();
  const canvas = new OffscreenCanvas(MOTION_W, MOTION_H);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  let prevData: Uint8ClampedArray | null = null;

  for (let i = 0; i < files.length; i++) {
    const bitmap = await createImageBitmap(files[i]);
    ctx.drawImage(bitmap, 0, 0, MOTION_W, MOTION_H);
    bitmap.close();

    const { data } = ctx.getImageData(0, 0, MOTION_W, MOTION_H);
    const pixels = new Uint8ClampedArray(data);

    if (prevData !== null) {
      let diff = 0;
      for (let j = 0; j < pixels.length; j += 4) {
        diff +=
          Math.abs(pixels[j] - prevData[j]) +
          Math.abs(pixels[j + 1] - prevData[j + 1]) +
          Math.abs(pixels[j + 2] - prevData[j + 2]);
      }
      const mad = diff / (MOTION_W * MOTION_H * 3);
      if (mad < threshold) inactive.add(i);
    }

    prevData = pixels;
    if (onProgress) onProgress(i + 1, files.length);
  }

  return inactive;
}

// ─── WebCodecs encoder ────────────────────────────────────────────────────────

async function pickCodec(width: number, height: number): Promise<string> {
  const candidates =
    width >= 3840
      ? ["avc1.640033", "avc1.640034", "avc1.4d0033"]
      : ["avc1.640028", "avc1.4d002a", "avc1.42001f"];

  for (const codec of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({ codec, width, height });
      if (support.supported) return codec;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    "Seu navegador não suporta codificação H.264 via WebCodecs. " +
      "Use Chrome 94+, Edge 94+, Firefox 130+ ou Safari 16.4+. " +
      'Experimente a opção "Fotos Limpas (ZIP)".',
  );
}

const PREFETCH_WINDOW = Math.max(4, Math.min((navigator.hardwareConcurrency ?? 4) * 2, 16));

async function encodeWithWebCodecs(
  files: File[],
  config: PipelineConfig,
  cb: PipelineCallbacks,
): Promise<{ blob: Blob; url: string; size: number }> {
  const total = files.length;
  if (total === 0) throw new Error("Nenhuma foto válida para gerar o vídeo.");

  cb.onEncodeProgress("loading", 0, 1);

  const { fps, width, height, bitrate } = config;
  const codec = await pickCodec(width, height);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width, height },
    fastStart: "in-memory",
  });

  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encoderError = e;
    },
  });

  encoder.configure({
    codec,
    width,
    height,
    bitrate,
    framerate: fps,
    latencyMode: "quality",
    hardwareAcceleration: "prefer-hardware",
  });

  cb.onEncodeProgress("loading", 1, 1);

  const pending = new Map<number, Promise<ImageBitmap>>();
  const kickDecode = (i: number) => {
    if (i < total && !pending.has(i)) pending.set(i, createImageBitmap(files[i]));
  };
  for (let i = 0; i < Math.min(PREFETCH_WINDOW, total); i++) kickDecode(i);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;

  for (let i = 0; i < total; i++) {
    if (encoderError) throw encoderError;

    const bitmap = await pending.get(i)!;
    pending.delete(i);
    kickDecode(i + PREFETCH_WINDOW);

    const scale = Math.min(width / bitmap.width, height / bitmap.height);
    const dw = Math.round(bitmap.width * scale);
    const dh = Math.round(bitmap.height * scale);
    const dx = Math.round((width - dw) / 2);
    const dy = Math.round((height - dh) / 2);
    if (dx > 0 || dy > 0) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(bitmap, dx, dy, dw, dh);
    bitmap.close();

    const frame = new VideoFrame(canvas, { timestamp: Math.round((i / fps) * 1_000_000) });
    encoder.encode(frame, { keyFrame: i % 90 === 0 });
    frame.close();

    if (encoder.encodeQueueSize > 40) await new Promise<void>((r) => setTimeout(r, 0));
    cb.onEncodeProgress("encoding", i + 1, total);
  }

  cb.onEncodeProgress("concatenating", 0, 1);
  await encoder.flush();
  if (encoderError) throw encoderError;

  muxer.finalize();
  cb.onEncodeProgress("concatenating", 1, 1);

  const blob = new Blob([target.buffer], { type: "video/mp4" });
  return { blob, url: URL.createObjectURL(blob), size: blob.size };
}

// ─── ZIP builder ──────────────────────────────────────────────────────────────

async function buildZip(
  files: File[],
  cb: PipelineCallbacks,
): Promise<{ blob: Blob; url: string; size: number }> {
  const total = files.length;
  if (total === 0) throw new Error("Nenhuma foto válida para compactar.");

  const zipEntries: Record<string, Uint8Array> = {};
  for (let i = 0; i < total; i++) {
    zipEntries[files[i].name] = new Uint8Array(await files[i].arrayBuffer());
    if (cb.onZipProgress) cb.onZipProgress(i + 1, total);
  }

  const blob = new Blob([zipSync(zipEntries, { level: 0 })], { type: "application/zip" });
  return { blob, url: URL.createObjectURL(blob), size: blob.size };
}

// ─── Public API ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PipelineConfig = {
  fps: 24,
  width: 1920,
  height: 1080,
  bitrate: 12_000_000,
  mode: "video",
  filters: DEFAULT_FILTERS,
};

export async function runPipeline(
  rawFiles: File[],
  cb: PipelineCallbacks,
  config: Partial<PipelineConfig> = {},
) {
  try {
    const cfg = {
      ...DEFAULT_CONFIG,
      ...config,
      filters: { ...DEFAULT_FILTERS, ...config.filters },
    };
    const files = [...rawFiles].sort((a, b) => a.name.localeCompare(b.name));
    const { accepted, rejected } = await analyzeAll(files, cb, cfg.filters);

    // Motion / inactivity filter (sequential, after defect analysis)
    let finalAccepted = accepted;
    const inactiveRejected: RejectedFrame[] = [];
    if (cfg.filters.filterInactive && accepted.length > 1) {
      const inactiveSet = await detectInactive(
        accepted,
        cfg.filters.inactiveThreshold,
        cb.onMotionProgress,
      );
      finalAccepted = accepted.filter((_, idx) => !inactiveSet.has(idx));
      accepted.forEach((f, idx) => {
        if (inactiveSet.has(idx)) {
          inactiveRejected.push({
            name: f.name,
            index: idx,
            reason: "Sem movimentação detectada",
            deadRatio: 0,
          });
        }
      });
    }

    const allRejected = [...rejected, ...inactiveRejected];
    const suggestedName = suggestOutputName(rawFiles).label;

    if (finalAccepted.length === 0) {
      cb.onError(
        "Nenhuma foto passou na análise. Todas foram identificadas como defeituosas ou fora dos filtros.",
      );
      return;
    }

    if (cfg.mode === "zip") {
      const { blob, url, size } = await buildZip(finalAccepted, cb);
      cb.onDone({
        zipBlob: blob,
        zipUrl: url,
        size,
        rejected: allRejected,
        usedCount: finalAccepted.length,
        totalCount: files.length,
        suggestedName,
      });
    } else {
      const { blob, url, size } = await encodeWithWebCodecs(finalAccepted, cfg, cb);
      cb.onDone({
        videoBlob: blob,
        videoUrl: url,
        size,
        rejected: allRejected,
        usedCount: finalAccepted.length,
        totalCount: files.length,
        suggestedName,
      });
    }
  } catch (err) {
    cb.onError((err as Error).message ?? String(err));
  }
}
