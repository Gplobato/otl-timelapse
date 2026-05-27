/// <reference lib="webworker" />
// Detector worker: rejects frames with horizontal gray stripes (camera artifacts),
// dark/blackout frames, uniform regions, nighttime darkness, and out-of-hours photos.

export type DetectorRequest = {
  id: string;
  file: File;
  index: number;
  // Optional extra filters
  filterNight?: boolean;
  nightThreshold?: number; // mean brightness below this = night (default 50)
  filterHours?: boolean;
  workStart?: number; // hour 0-23, default 8
  workEnd?: number; // hour 0-23, default 17
};

export type DetectorResponse = {
  id: string;
  index: number;
  name: string;
  ok: boolean;
  reason?: string;
  deadRatio: number;
  thumb?: string;
};

const TARGET_WIDTH = 320;
const BAND_HEIGHT = 4;
const VARIANCE_THRESHOLD = 30;
const GRAY_VARIANCE_THRESHOLD = 120;
const GRAY_MEAN_MIN = 60;
const GRAY_MEAN_MAX = 220;
const DEAD_RATIO_REJECT = 0.08;
const DARK_THRESHOLD = 18; // absolute blackout
const DEFAULT_NIGHT_THRESHOLD = 50; // nighttime (above blackout, below this)
const DEFAULT_WORK_START = 8;
const DEFAULT_WORK_END = 17;

// Parse YYYYMMDDHHMMSS from filename: "S 63 Montreal_00_20260404082825.jpg"
function parseHourFromFilename(name: string): number | null {
  const basename = name.replace(/\.[^.]+$/, "");
  const parts = basename.split("_");
  const datetime = parts[parts.length - 1];
  if (datetime && /^\d{14}$/.test(datetime)) {
    return parseInt(datetime.substring(8, 10), 10);
  }
  return null;
}

async function analyze(
  file: File,
  req: DetectorRequest,
): Promise<Omit<DetectorResponse, "id" | "index" | "name">> {
  const bitmap = await createImageBitmap(file);
  const ratio = TARGET_WIDTH / bitmap.width;
  const w = TARGET_WIDTH;
  const h = Math.max(1, Math.round(bitmap.height * ratio));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, w, h);

  const gray = new Uint8ClampedArray(w * h);
  let totalSum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    gray[p] = g;
    totalSum += g;
  }

  const imageMean = totalSum / (w * h);

  // ── Absolute blackout ──────────────────────────────────────────────────────
  if (imageMean < DARK_THRESHOLD) {
    const thumb = await makeThumb(canvas, w, h);
    return { ok: false, deadRatio: 1, reason: "Frame escuro / blackout", thumb };
  }

  // ── Night filter (optional) ────────────────────────────────────────────────
  if (req.filterNight) {
    const nightThreshold = req.nightThreshold ?? DEFAULT_NIGHT_THRESHOLD;
    if (imageMean < nightThreshold) {
      const thumb = await makeThumb(canvas, w, h);
      return {
        ok: false,
        deadRatio: imageMean / 255,
        reason: `Foto noturna (brilho médio ${imageMean.toFixed(0)})`,
        thumb,
      };
    }
  }

  // ── Hours filter (optional) ────────────────────────────────────────────────
  if (req.filterHours) {
    const hour = parseHourFromFilename(file.name);
    if (hour !== null) {
      const workStart = req.workStart ?? DEFAULT_WORK_START;
      const workEnd = req.workEnd ?? DEFAULT_WORK_END;
      if (hour < workStart || hour >= workEnd) {
        return {
          ok: false,
          deadRatio: 0,
          reason: `Fora do horário de obra (${String(hour).padStart(2, "0")}h)`,
        };
      }
    }
  }

  // ── Band analysis (gray stripes + uniform regions) ────────────────────────
  const totalBands = Math.floor(h / BAND_HEIGHT);
  let uniformBands = 0;
  let consecutiveGrayStripe = 0;
  let maxConsecutiveGray = 0;

  for (let b = 0; b < totalBands; b++) {
    const start = b * BAND_HEIGHT * w;
    const end = start + BAND_HEIGHT * w;
    const n = end - start;

    let sum = 0;
    for (let i = start; i < end; i++) sum += gray[i];
    const mean = sum / n;

    let varSum = 0;
    for (let i = start; i < end; i++) {
      const d = gray[i] - mean;
      varSum += d * d;
    }
    const variance = varSum / n;

    if (variance < VARIANCE_THRESHOLD) uniformBands++;

    const isGrayStripe =
      mean >= GRAY_MEAN_MIN && mean <= GRAY_MEAN_MAX && variance < GRAY_VARIANCE_THRESHOLD;

    if (isGrayStripe) {
      consecutiveGrayStripe++;
      if (consecutiveGrayStripe > maxConsecutiveGray) maxConsecutiveGray = consecutiveGrayStripe;
    } else {
      consecutiveGrayStripe = 0;
    }
  }

  const deadRatio = totalBands ? uniformBands / totalBands : 0;

  if (maxConsecutiveGray >= 2) {
    const thumb = await makeThumb(canvas, w, h);
    return {
      ok: false,
      deadRatio,
      reason: `Listra cinza detectada (~${maxConsecutiveGray * BAND_HEIGHT}px de altura)`,
      thumb,
    };
  }

  if (deadRatio >= DEAD_RATIO_REJECT) {
    const thumb = await makeThumb(canvas, w, h);
    return {
      ok: false,
      deadRatio,
      reason: `${Math.round(deadRatio * 100)}% da imagem é cor uniforme`,
      thumb,
    };
  }

  return { ok: true, deadRatio };
}

async function makeThumb(canvas: OffscreenCanvas, w: number, h: number): Promise<string> {
  const thumbCanvas = new OffscreenCanvas(160, Math.max(1, Math.round(160 * (h / w))));
  const tctx = thumbCanvas.getContext("2d")!;
  tctx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const blob = await thumbCanvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
  return blobToDataURL(blob);
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

self.onmessage = async (e: MessageEvent<DetectorRequest>) => {
  const req = e.data;
  try {
    const result = await analyze(req.file, req);
    const response: DetectorResponse = {
      id: req.id,
      index: req.index,
      name: req.file.name,
      ...result,
    };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: DetectorResponse = {
      id: req.id,
      index: req.index,
      name: req.file.name,
      ok: false,
      deadRatio: 1,
      reason: `Erro ao analisar: ${(err as Error).message}`,
    };
    (self as unknown as Worker).postMessage(response);
  }
};
