import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";

type JsonObject = Record<string, unknown>;

type TimelapseStatus = "queued" | "processing" | "done" | "error" | "cancelled";

type TimelapsePhase =
  | "queued"
  | "listing"
  | "filtering"
  | "preparing"
  | "encoding"
  | "finalizing"
  | "done"
  | "error";

type TimelapseFilters = {
  filterNight?: boolean;
  nightThreshold?: number;
  filterHours?: boolean;
  workStart?: number;
  workEnd?: number;
  filterInactive?: boolean;
  inactiveThreshold?: number;
};

type CreateJobPayload = {
  obra_id?: string;
  camera_id?: string;
  source_path?: string;
  from?: string;
  to?: string;
  fps?: number;
  resolution?: "1080p" | "4k";
  mode?: "video";
  filters?: TimelapseFilters;
  frames?: Array<{
    path?: string;
    name?: string;
    timestamp?: string;
  }>;
};

type FrameEntry = {
  path: string;
  name: string;
  timestamp?: string;
};

type TimelapseJob = {
  job_id: string;
  status: TimelapseStatus;
  phase: TimelapsePhase;
  progress: number;
  message: string;
  obra_id?: string;
  camera_id?: string;
  config: Required<Pick<CreateJobPayload, "fps" | "resolution" | "mode">> & {
    from?: string;
    to?: string;
    filters: TimelapseFilters;
  };
  warnings: string[];
  video_path?: string;
  video_url?: string;
  download_url?: string;
  frames_total?: number;
  frames_used?: number;
  frames_rejected?: number;
  error_message?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
};

type RuntimeEnv = Record<string, string | undefined>;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
const RESOLUTIONS = {
  "1080p": { width: 1920, height: 1080, bitrate: "12M" },
  "4k": { width: 3840, height: 2160, bitrate: "50M" },
} as const;
const DEFAULT_FPS = 24;
const DEFAULT_RESOLUTION: keyof typeof RESOLUTIONS = "1080p";

type NormalizedCreateJobPayload = {
  obra_id?: string;
  camera_id?: string;
  source_path?: string;
  from?: string;
  to?: string;
  fps: number;
  resolution: keyof typeof RESOLUTIONS;
  mode: "video";
  filters: TimelapseFilters;
  frames: NonNullable<CreateJobPayload["frames"]>;
};

const jobs = new Map<string, TimelapseJob>();
let hasLoadedJobs = false;
let writeQueue = Promise.resolve();

function getProcessEnv(): RuntimeEnv {
  const maybeProcess = globalThis as typeof globalThis & {
    process?: { env?: RuntimeEnv };
  };
  return maybeProcess.process?.env ?? {};
}

function getEnv(rawEnv: unknown): RuntimeEnv {
  return { ...getProcessEnv(), ...((rawEnv as RuntimeEnv | undefined) ?? {}) };
}

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

function getBearerToken(request: Request) {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  return header.slice("bearer ".length).trim();
}

function authorize(request: Request, env: RuntimeEnv): Response | null {
  const configuredKey = env.TIMELAPSE_API_KEY;
  if (!configuredKey) {
    return json(
      {
        error: "TIMELAPSE_API_KEY não configurada",
        message: "Configure uma chave para permitir chamadas server-to-server.",
      },
      { status: 503 },
    );
  }

  const token = getBearerToken(request) ?? request.headers.get("x-api-key");
  if (token !== configuredKey) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  return null;
}

function getOutputDir(env: RuntimeEnv) {
  return env.TIMELAPSE_OUTPUT_DIR || path.join(tmpdir(), "otl-timelapse-output");
}

function getJobsPath(env: RuntimeEnv) {
  return path.join(getOutputDir(env), "jobs.json");
}

async function loadJobs(env: RuntimeEnv) {
  if (hasLoadedJobs) return;
  hasLoadedJobs = true;

  try {
    const raw = await readFile(getJobsPath(env), "utf8");
    const parsed = JSON.parse(raw) as TimelapseJob[];
    for (const job of parsed) jobs.set(job.job_id, job);
  } catch {
    // No persisted jobs yet.
  }
}

function persistJobs(env: RuntimeEnv) {
  writeQueue = writeQueue.then(async () => {
    await mkdir(getOutputDir(env), { recursive: true });
    await writeFile(getJobsPath(env), JSON.stringify([...jobs.values()], null, 2));
  });
  return writeQueue;
}

function publicJob(job: TimelapseJob) {
  const { video_path: _videoPath, ...safeJob } = job;
  return safeJob;
}

function updateJob(env: RuntimeEnv, jobId: string, patch: Partial<TimelapseJob>) {
  const current = jobs.get(jobId);
  if (!current) return;
  const updated: TimelapseJob = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  jobs.set(jobId, updated);
  void persistJobs(env);
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizePayload(payload: CreateJobPayload): NormalizedCreateJobPayload {
  return {
    obra_id: payload.obra_id,
    camera_id: payload.camera_id,
    source_path: payload.source_path,
    from: payload.from,
    to: payload.to,
    fps: normalizeNumber(payload.fps, DEFAULT_FPS, 1, 60),
    resolution: payload.resolution === "4k" ? "4k" : DEFAULT_RESOLUTION,
    mode: "video" as const,
    filters: payload.filters ?? {},
    frames: payload.frames ?? [],
  };
}

function parseTimestampFromName(name: string) {
  const match = name.match(/(\d{14})/);
  if (!match) return undefined;
  const value = match[1];
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(
    8,
    10,
  )}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`;
}

function toMillis(value?: string) {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function isImage(name: string) {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function assertWithinRoot(root: string, candidate: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(root, candidate);
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error("Caminho fora do diretório NAS permitido");
  }
  return resolvedCandidate;
}

function getNasRoot(env: RuntimeEnv) {
  return env.TIMELAPSE_NAS_ROOT;
}

function resolveSourceDirectory(env: RuntimeEnv, payload: NormalizedCreateJobPayload) {
  const nasRoot = getNasRoot(env);
  if (!nasRoot) {
    throw new Error("TIMELAPSE_NAS_ROOT não configurado");
  }

  const relativeSource = payload.source_path || payload.camera_id;
  if (!relativeSource) {
    throw new Error("Informe camera_id, source_path ou frames[]");
  }

  return assertWithinRoot(nasRoot, relativeSource);
}

async function walkImages(directory: string, limit = 20000): Promise<FrameEntry[]> {
  const out: FrameEntry[] = [];

  async function walk(current: string) {
    if (out.length >= limit) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= limit) return;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && isImage(entry.name)) {
        out.push({
          path: entryPath,
          name: entry.name,
          timestamp: parseTimestampFromName(entry.name),
        });
      }
    }
  }

  await walk(directory);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function filterFrames(frames: FrameEntry[], payload: NormalizedCreateJobPayload) {
  const from = toMillis(payload.from);
  const to = toMillis(payload.to);
  const filters = payload.filters;
  const rejected = { date: 0, hours: 0 };

  const used = frames.filter((frame) => {
    const ts = frame.timestamp ? toMillis(frame.timestamp) : undefined;
    if (ts != null && from != null && ts < from) {
      rejected.date++;
      return false;
    }
    if (ts != null && to != null && ts > to) {
      rejected.date++;
      return false;
    }

    if (filters.filterHours && ts != null) {
      const hour = new Date(ts).getUTCHours();
      const start = normalizeNumber(filters.workStart, 8, 0, 23);
      const end = normalizeNumber(filters.workEnd, 17, 0, 23);
      const inWindow = start <= end ? hour >= start && hour <= end : hour >= start || hour <= end;
      if (!inWindow) {
        rejected.hours++;
        return false;
      }
    }

    return true;
  });

  return { used, rejected };
}

async function resolvePayloadFrames(env: RuntimeEnv, payload: NormalizedCreateJobPayload) {
  if (payload.frames.length > 0) {
    const nasRoot = getNasRoot(env);
    const frames = payload.frames
      .filter((frame) => frame.path && isImage(frame.name || frame.path))
      .map((frame) => {
        const framePath = nasRoot
          ? assertWithinRoot(nasRoot, frame.path!)
          : path.resolve(frame.path!);
        return {
          path: framePath,
          name: frame.name || path.basename(framePath),
          timestamp: frame.timestamp || parseTimestampFromName(frame.name || framePath),
        };
      });
    return frames.sort((a, b) => a.name.localeCompare(b.name));
  }

  return walkImages(resolveSourceDirectory(env, payload));
}

function createJob(payload: NormalizedCreateJobPayload): TimelapseJob {
  const now = new Date().toISOString();
  const jobId = `tl_${randomUUID()}`;
  const warnings: string[] = [];

  if (payload.filters.filterNight) {
    warnings.push("Filtro de noite ainda não foi portado para o backend; será ignorado neste job.");
  }
  if (payload.filters.filterInactive) {
    warnings.push(
      "Filtro de inatividade ainda não foi portado para o backend; será ignorado neste job.",
    );
  }

  return {
    job_id: jobId,
    status: "queued",
    phase: "queued",
    progress: 0,
    message: "Job enfileirado",
    obra_id: payload.obra_id,
    camera_id: payload.camera_id,
    config: {
      fps: payload.fps,
      resolution: payload.resolution,
      mode: payload.mode,
      from: payload.from,
      to: payload.to,
      filters: payload.filters,
    },
    warnings,
    created_at: now,
    updated_at: now,
  };
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeConcatList(frames: FrameEntry[], fps: number, workDir: string) {
  const framesDir = path.join(workDir, "frames");
  await mkdir(framesDir, { recursive: true });

  const lines: string[] = [];
  const duration = 1 / fps;

  for (let i = 0; i < frames.length; i++) {
    const source = frames[i].path;
    const ext = path.extname(source).toLowerCase() || ".jpg";
    const linkedPath = path.join(framesDir, `frame-${String(i + 1).padStart(6, "0")}${ext}`);
    await symlink(source, linkedPath);
    lines.push(`file ${shellQuote(linkedPath)}`);
    lines.push(`duration ${duration.toFixed(6)}`);
  }

  const last = lines[lines.length - 2];
  if (last) lines.push(last);

  const listPath = path.join(workDir, "frames.txt");
  await writeFile(listPath, `${lines.join("\n")}\n`);
  return listPath;
}

function runFfmpeg(args: string[], onProgress: (progress: number, message: string) => void) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const frameMatch = stderr
        .match(/frame=\s*(\d+)/g)
        ?.at(-1)
        ?.match(/\d+/);
      if (frameMatch) {
        onProgress(60, `Codificando frame ${frameMatch[0]}`);
      }
    });

    child.on("error", (error) => {
      reject(new Error(`Falha ao iniciar ffmpeg: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.slice(-2000)}`));
      }
    });
  });
}

async function runJob(env: RuntimeEnv, jobId: string, payload: NormalizedCreateJobPayload) {
  try {
    updateJob(env, jobId, {
      status: "processing",
      phase: "listing",
      progress: 5,
      message: "Listando imagens do NAS",
    });

    const allFrames = await resolvePayloadFrames(env, payload);
    updateJob(env, jobId, {
      phase: "filtering",
      progress: 15,
      message: "Filtrando imagens por período e horário",
      frames_total: allFrames.length,
    });

    const { used } = filterFrames(allFrames, payload);
    if (used.length === 0) {
      throw new Error("Nenhuma imagem encontrada para os filtros informados");
    }

    const outputDir = getOutputDir(env);
    const jobDir = path.join(outputDir, jobId);
    await mkdir(jobDir, { recursive: true });

    updateJob(env, jobId, {
      phase: "preparing",
      progress: 30,
      message: "Preparando lista de frames para o ffmpeg",
      frames_used: used.length,
      frames_rejected: allFrames.length - used.length,
    });

    const listPath = await writeConcatList(used, payload.fps, jobDir);
    const resolution = RESOLUTIONS[payload.resolution];
    const outputPath = path.join(jobDir, "timelapse.mp4");
    const vf = [
      `scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease`,
      `pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2`,
      "format=yuv420p",
    ].join(",");

    updateJob(env, jobId, {
      phase: "encoding",
      progress: 45,
      message: "Gerando MP4 com ffmpeg",
    });

    await runFfmpeg(
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-vf",
        vf,
        "-r",
        String(payload.fps),
        "-c:v",
        "libx264",
        "-b:v",
        resolution.bitrate,
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      (progress, message) => updateJob(env, jobId, { progress, message }),
    );

    const outputStat = await stat(outputPath);
    if (!outputStat.isFile() || outputStat.size === 0) {
      throw new Error("ffmpeg não gerou um MP4 válido");
    }

    updateJob(env, jobId, {
      status: "done",
      phase: "done",
      progress: 100,
      message: "Timelapse concluído",
      video_path: outputPath,
      video_url: `/api/timelapse/jobs/${jobId}/download`,
      download_url: `/api/timelapse/jobs/${jobId}/download`,
      frames_used: used.length,
      frames_rejected: allFrames.length - used.length,
      completed_at: new Date().toISOString(),
    });
  } catch (error) {
    updateJob(env, jobId, {
      status: "error",
      phase: "error",
      progress: 100,
      message: "Falha ao gerar timelapse",
      error_message: error instanceof Error ? error.message : "Erro desconhecido",
      completed_at: new Date().toISOString(),
    });
  }
}

async function parseJsonBody(request: Request): Promise<JsonObject> {
  try {
    return (await request.json()) as JsonObject;
  } catch {
    throw new Error("Body JSON inválido");
  }
}

async function createJobHandler(request: Request, env: RuntimeEnv) {
  const rawPayload = (await parseJsonBody(request)) as CreateJobPayload;
  const payload = normalizePayload(rawPayload);
  const job = createJob(payload);

  jobs.set(job.job_id, job);
  await persistJobs(env);
  void runJob(env, job.job_id, payload);

  return json({ job_id: job.job_id, status: job.status }, { status: 202 });
}

async function listFramesHandler(url: URL, env: RuntimeEnv) {
  const payload = normalizePayload({
    camera_id: url.searchParams.get("camera_id") || undefined,
    source_path: url.searchParams.get("source_path") || undefined,
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    filters: {
      filterHours: url.searchParams.get("filterHours") === "true",
      workStart: Number(url.searchParams.get("workStart") ?? 8),
      workEnd: Number(url.searchParams.get("workEnd") ?? 17),
    },
  });

  const frames = await resolvePayloadFrames(env, payload);
  const { used } = filterFrames(frames, payload);

  return json({
    frames_total: frames.length,
    frames_used: used.length,
    frames: used.slice(0, 500).map((frame) => ({
      name: frame.name,
      timestamp: frame.timestamp,
      id: createHash("sha1").update(frame.path).digest("hex"),
    })),
    truncated: used.length > 500,
  });
}

function streamFile(filePath: string, filename: string) {
  const stream = createReadStream(filePath);
  const body = Readable.toWeb(stream) as BodyInit;
  return new Response(body, {
    headers: {
      "content-type": "video/mp4",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

async function downloadHandler(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return json({ error: "job_not_found" }, { status: 404 });
  if (job.status !== "done" || !job.video_path) {
    return json({ error: "job_not_ready" }, { status: 409 });
  }
  return streamFile(job.video_path, `${jobId}.mp4`);
}

export async function handleTimelapseApi(
  request: Request,
  rawEnv: unknown,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/timelapse")) return undefined;

  const env = getEnv(rawEnv);
  await loadJobs(env);

  if (url.pathname === "/api/timelapse/health") {
    return json({
      ok: true,
      service: "otl-timelapse-api",
      has_api_key: Boolean(env.TIMELAPSE_API_KEY),
      has_nas_root: Boolean(env.TIMELAPSE_NAS_ROOT),
      output_dir: getOutputDir(env),
    });
  }

  const authError = authorize(request, env);
  if (authError) return authError;

  try {
    if (url.pathname === "/api/timelapse/list" && request.method === "GET") {
      return await listFramesHandler(url, env);
    }

    if (url.pathname === "/api/timelapse/jobs" && request.method === "GET") {
      return json({ jobs: [...jobs.values()].map(publicJob) });
    }

    if (url.pathname === "/api/timelapse/jobs" && request.method === "POST") {
      return await createJobHandler(request, env);
    }

    const jobMatch = url.pathname.match(/^\/api\/timelapse\/jobs\/([^/]+)$/);
    if (jobMatch && request.method === "GET") {
      const job = jobs.get(jobMatch[1]);
      return job ? json(publicJob(job)) : json({ error: "job_not_found" }, { status: 404 });
    }

    const downloadMatch = url.pathname.match(/^\/api\/timelapse\/jobs\/([^/]+)\/download$/);
    if (downloadMatch && request.method === "GET") {
      return await downloadHandler(downloadMatch[1]);
    }

    return json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return json(
      {
        error: "request_failed",
        message: error instanceof Error ? error.message : "Erro desconhecido",
      },
      { status: 400 },
    );
  }
}
