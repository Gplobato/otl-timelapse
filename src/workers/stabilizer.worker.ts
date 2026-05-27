/// <reference lib="webworker" />

export type StabilizerWorkerRequest = {
  id: string;
  width: number;
  height: number;
  prev: Uint8ClampedArray;
  current: Uint8ClampedArray;
  searchRadius: number;
};

export type StabilizerWorkerResponse = {
  id: string;
  dx: number;
  dy: number;
  score: number;
};

function estimateTranslation(req: StabilizerWorkerRequest): Omit<StabilizerWorkerResponse, "id"> {
  const { width, height, prev, current, searchRadius } = req;
  const margin = searchRadius + 6;
  const step = 3;

  let bestDx = 0;
  let bestDy = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let dy = -searchRadius; dy <= searchRadius; dy++) {
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      let score = 0;
      let count = 0;

      for (let y = margin; y < height - margin; y += step) {
        const prevRow = y * width;
        const currRow = (y + dy) * width;
        for (let x = margin; x < width - margin; x += step) {
          score += Math.abs(prev[prevRow + x] - current[currRow + x + dx]);
          count++;
        }
      }

      const normalized = count > 0 ? score / count : Number.POSITIVE_INFINITY;
      if (normalized < bestScore) {
        bestScore = normalized;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  return { dx: bestDx, dy: bestDy, score: bestScore };
}

self.onmessage = (event: MessageEvent<StabilizerWorkerRequest>) => {
  const req = event.data;
  const result = estimateTranslation(req);
  const response: StabilizerWorkerResponse = { id: req.id, ...result };
  (self as unknown as Worker).postMessage(response);
};
