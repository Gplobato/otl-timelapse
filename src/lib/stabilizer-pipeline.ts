import { unzipSync } from "fflate";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import type {
  StabilizerWorkerRequest,
  StabilizerWorkerResponse,
} from "@/workers/stabilizer.worker";

export type StabilizerPhase = "loading" | "analyzing" | "stabilizing" | "encoding" | "finalizing";

export type StabilizerConfig = {
  fps: number;
  width: number;
  height: number;
  bitrate: number;
  smoothingWindow: number;
  cropPercent: number;
  searchRadius: number;
};

export type StabilizerCallbacks = {
  onProgress: (phase: StabilizerPhase, current: number, total: number) => void;
  onLog?: (message: string) => void;
  onDone: (result: {
    videoBlob: Blob;
    videoUrl: string;
    size: number;
    frameCount: number;
    suggestedName: string;
    maxShift: number;
  }) => void;
  onError: (message: string) => void;
};

type GrayFrame = {
  file: File;
  gray: Uint8ClampedArray;
};

type Offset = {
  dx: number;
  dy: number;
  score: number;
};

const THUMB_W = 192;
const THUMB_H = 108;
const MAX_FRAMES = 2500;

const DEFAULT_CONFIG: StabilizerConfig = {
  fps: 24,
  width: 1920,
  height: 1080,
  bitrate: 12_000_000,
  smoothingWindow: 25,
  cropPercent: 0.06,
  searchRadius: 10,
};

function spawnStabilizerWorker() {
  return new Worker(new URL("../workers/stabilizer.worker.ts", import.meta.url), {
    type: "module",
  });
}

function isImageName(name: string) {
  return /\.(jpe?g|png)$/i.test(name);
}

function isZipName(name: string) {
  return /\.zip$/i.test(name);
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, "");
}

function suggestStabilizedName(files: File[]) {
  const first = files[0]?.name ? baseName(files[0].name) : "timelapse";
  return `${first} - estabilizado`;
}

export async function expandStabilizerFiles(rawFiles: File[]): Promise<File[]> {
  const images: File[] = [];

  for (const file of rawFiles) {
    if (isImageName(file.name)) {
      images.push(file);
      continue;
    }

    if (!isZipName(file.name)) continue;

    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    for (const [name, data] of Object.entries(entries)) {
      if (!isImageName(name)) continue;
      const ext = name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      images.push(new File([data], name.split("/").pop() || name, { type: ext }));
    }
  }

  return images.sort((a, b) => a.name.localeCompare(b.name));
}

async function toGrayFrame(file: File): Promise<GrayFrame> {
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(THUMB_W, THUMB_H);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  const scale = Math.min(THUMB_W / bitmap.width, THUMB_H / bitmap.height);
  const dw = Math.round(bitmap.width * scale);
  const dh = Math.round(bitmap.height * scale);
  ctx.drawImage(bitmap, Math.round((THUMB_W - dw) / 2), Math.round((THUMB_H - dh) / 2), dw, dh);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, THUMB_W, THUMB_H);
  const gray = new Uint8ClampedArray(THUMB_W * THUMB_H);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }

  return { file, gray };
}

function estimateOffset(
  worker: Worker,
  prev: Uint8ClampedArray,
  current: Uint8ClampedArray,
  searchRadius: number,
): Promise<Offset> {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const onMessage = (event: MessageEvent<StabilizerWorkerResponse>) => {
      if (event.data.id !== id) return;
      cleanup();
      resolve({ dx: event.data.dx, dy: event.data.dy, score: event.data.score });
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || "Erro ao estimar estabilidade"));
    };
    const cleanup = () => {
      worker.removeEventListener("message", onMessage as EventListener);
      worker.removeEventListener("error", onError as EventListener);
    };

    worker.addEventListener("message", onMessage as EventListener);
    worker.addEventListener("error", onError as EventListener);
    const req: StabilizerWorkerRequest = {
      id,
      width: THUMB_W,
      height: THUMB_H,
      prev,
      current,
      searchRadius,
    };
    worker.postMessage(req);
  });
}

function smoothOffsets(offsets: Offset[], windowSize: number) {
  const path = offsets.map(() => ({ x: 0, y: 0 }));
  for (let i = 1; i < offsets.length; i++) {
    path[i] = {
      x: path[i - 1].x + offsets[i].dx,
      y: path[i - 1].y + offsets[i].dy,
    };
  }

  const radius = Math.max(1, Math.floor(windowSize / 2));
  const corrections = path.map((point, i) => {
    let sx = 0;
    let sy = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(path.length - 1, i + radius); j++) {
      sx += path[j].x;
      sy += path[j].y;
      count++;
    }
    const smoothX = sx / count;
    const smoothY = sy / count;
    return {
      dx: smoothX - point.x,
      dy: smoothY - point.y,
    };
  });

  const maxShift = corrections.reduce((max, c) => Math.max(max, Math.hypot(c.dx, c.dy)), 0);
  return { corrections, maxShift };
}

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
      // Try next H.264 profile.
    }
  }

  throw new Error(
    "Seu navegador não suporta codificação H.264 via WebCodecs. Use Chrome ou Edge atualizado em HTTPS.",
  );
}

async function encodeStabilized(
  files: File[],
  corrections: { dx: number; dy: number }[],
  config: StabilizerConfig,
  cb: StabilizerCallbacks,
) {
  const codec = await pickCodec(config.width, config.height);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: config.width, height: config.height },
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
    width: config.width,
    height: config.height,
    bitrate: config.bitrate,
    framerate: config.fps,
    latencyMode: "quality",
    hardwareAcceleration: "prefer-hardware",
  });

  const canvas = new OffscreenCanvas(config.width, config.height);
  const ctx = canvas.getContext("2d")!;
  const scaleX = config.width / THUMB_W;
  const scaleY = config.height / THUMB_H;

  for (let i = 0; i < files.length; i++) {
    if (encoderError) throw encoderError;
    cb.onProgress("encoding", i + 1, files.length);

    const bitmap = await createImageBitmap(files[i]);
    const baseScale = Math.max(config.width / bitmap.width, config.height / bitmap.height);
    const scale = baseScale * (1 + config.cropPercent);
    const dw = Math.round(bitmap.width * scale);
    const dh = Math.round(bitmap.height * scale);
    const correction = corrections[i] ?? { dx: 0, dy: 0 };
    const dx = Math.round((config.width - dw) / 2 + correction.dx * scaleX);
    const dy = Math.round((config.height - dh) / 2 + correction.dy * scaleY);

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, config.width, config.height);
    ctx.drawImage(bitmap, dx, dy, dw, dh);
    bitmap.close();

    const frame = new VideoFrame(canvas, { timestamp: Math.round((i / config.fps) * 1_000_000) });
    encoder.encode(frame, { keyFrame: i % 90 === 0 });
    frame.close();

    if (encoder.encodeQueueSize > 40) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  cb.onProgress("finalizing", 0, 1);
  await encoder.flush();
  if (encoderError) throw encoderError;

  muxer.finalize();
  cb.onProgress("finalizing", 1, 1);

  const blob = new Blob([target.buffer], { type: "video/mp4" });
  return { blob, url: URL.createObjectURL(blob), size: blob.size };
}

export async function runStabilizerPipeline(
  rawFiles: File[],
  callbacks: StabilizerCallbacks,
  config: Partial<StabilizerConfig> = {},
) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  try {
    callbacks.onLog?.("Carregando imagens para estabilização...");
    callbacks.onProgress("loading", 0, 1);
    const files = await expandStabilizerFiles(rawFiles);
    callbacks.onProgress("loading", 1, 1);

    if (files.length < 2) {
      throw new Error("Selecione pelo menos 2 imagens JPG/PNG ou um ZIP com imagens.");
    }
    if (files.length > MAX_FRAMES) {
      throw new Error(
        `Este MVP suporta até ${MAX_FRAMES.toLocaleString("pt-BR")} frames por lote.`,
      );
    }

    callbacks.onLog?.(
      `${files.length.toLocaleString("pt-BR")} frames encontrados. Analisando tremor...`,
    );
    const grayFrames: GrayFrame[] = [];
    for (let i = 0; i < files.length; i++) {
      grayFrames.push(await toGrayFrame(files[i]));
      callbacks.onProgress("analyzing", i + 1, files.length);
    }

    const worker = spawnStabilizerWorker();
    const offsets: Offset[] = [{ dx: 0, dy: 0, score: 0 }];
    try {
      for (let i = 1; i < grayFrames.length; i++) {
        offsets.push(
          await estimateOffset(
            worker,
            grayFrames[i - 1].gray,
            grayFrames[i].gray,
            cfg.searchRadius,
          ),
        );
        callbacks.onProgress("stabilizing", i, grayFrames.length - 1);
      }
    } finally {
      worker.terminate();
    }

    const { corrections, maxShift } = smoothOffsets(offsets, cfg.smoothingWindow);
    callbacks.onLog?.(`Correção máxima estimada: ${maxShift.toFixed(1)} px na prévia.`);
    callbacks.onLog?.("Gerando MP4 estabilizado...");

    const { blob, url, size } = await encodeStabilized(
      grayFrames.map((f) => f.file),
      corrections,
      cfg,
      callbacks,
    );

    callbacks.onDone({
      videoBlob: blob,
      videoUrl: url,
      size,
      frameCount: files.length,
      suggestedName: suggestStabilizedName(files),
      maxShift,
    });
  } catch (err) {
    callbacks.onError((err as Error).message ?? String(err));
  }
}
