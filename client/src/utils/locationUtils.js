import { getNativeLocationPayload, isTauri } from "./tauriNative";

const CACHE_MS = 5 * 60 * 1000;

let cached = null;
let cachedAt = 0;
let shareEnabled = true;

export function setShareLocationEnabled(enabled) {
  shareEnabled = Boolean(enabled);
  if (!shareEnabled) {
    cached = null;
    cachedAt = 0;
  }
}

/**
 * @returns {Promise<{ client_latitude?: number, client_longitude?: number, client_location_accuracy_m?: number }>}
 */
export async function getClientLocationPayload() {
  if (!shareEnabled) {
    return {};
  }

  const now = Date.now();
  if (cached && now - cachedAt < CACHE_MS) {
    return { ...cached };
  }

  if (isTauri()) {
    try {
      const payload = await getNativeLocationPayload();
      cached = { ...payload };
      cachedAt = now;
      return { ...cached };
    } catch {
      return {};
    }
  }

  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return {};
  }

  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: CACHE_MS,
      });
    });
    cached = {
      client_latitude: pos.coords.latitude,
      client_longitude: pos.coords.longitude,
      ...(pos.coords.accuracy != null
        ? { client_location_accuracy_m: pos.coords.accuracy }
        : {}),
    };
    cachedAt = now;
    return { ...cached };
  } catch {
    return {};
  }
}

/** Warm the location cache (non-blocking). */
export function prefetchClientLocation() {
  if (shareEnabled) {
    getClientLocationPayload().catch(() => {});
  }
}
