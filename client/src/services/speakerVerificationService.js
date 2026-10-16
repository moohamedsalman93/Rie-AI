/**
 * Speaker Verification Client Service.
 * Communicates with the Python FastAPI backend (/api/speaker/verify)
 * to verify speaker embeddings using Sherpa-ONNX.
 */

import { API_BASE_URL, getAppToken } from "./chatApi";

export class SpeakerVerificationService {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || (typeof API_BASE_URL !== "undefined" && API_BASE_URL ? API_BASE_URL : "http://localhost:8000");
    this.timeoutMs = options.timeoutMs || 4000;
  }

  /**
   * Send 16-bit PCM audio (base64 string or ArrayBuffer) to the backend for verification.
   *
   * @param {string|ArrayBuffer|Uint8Array} audio - Base64 string or raw PCM ArrayBuffer
   * @param {number} sampleRate - Sample rate in Hz (default: 16000)
   * @returns {Promise<{ speaker: string, score: number, verdict: string, is_user: boolean, latency_ms: number }>}
   */
  async verifyPCM(audio, sampleRate = 16000) {
    const token = typeof getAppToken === "function" ? getAppToken() : null;
    const headers = {};
    if (token) {
      headers["X-Rie-App-Token"] = token;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let response;
      if (typeof audio === "string") {
        // Base64 JSON payload
        headers["Content-Type"] = "application/json";
        response = await fetch(`${this.baseUrl}/api/speaker/verify`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            audio,
            sample_rate: sampleRate,
            sample_width: 2,
          }),
          signal: controller.signal,
        });
      } else {
        // High-performance raw binary stream
        headers["Content-Type"] = "application/octet-stream";
        headers["x-sample-rate"] = String(sampleRate);
        const bodyData = audio;
        response = await fetch(`${this.baseUrl}/api/speaker/verify`, {
          method: "POST",
          headers,
          body: bodyData,
          signal: controller.signal,
        });
      }

      if (!response.ok) {
        if (response.status === 404) {
          this._enrolledCache = false;
          this._enrolledCacheTime = Date.now();
        }
        const errorText = await response.text().catch(() => "");
        const err = new Error(`Speaker verification failed [HTTP ${response.status}]: ${errorText}`);
        err.status = response.status;
        throw err;
      }

      const result = await response.json();
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Check speaker engine status.
   */
  async getStatus() {
    const token = typeof getAppToken === "function" ? getAppToken() : null;
    const headers = token ? { "X-Rie-App-Token": token } : {};
    const res = await fetch(`${this.baseUrl}/api/speaker/status`, { headers });
    if (!res.ok) throw new Error(`Status check failed: HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Retrieve enrolled speaker profile details.
   */
  async getProfile() {
    const token = typeof getAppToken === "function" ? getAppToken() : null;
    const headers = token ? { "X-Rie-App-Token": token } : {};
    const res = await fetch(`${this.baseUrl}/api/speaker/profile`, { headers });
    if (!res.ok) throw new Error(`Profile fetch failed: HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Fast cached check for whether a user voice profile is registered.
   */
  async isUserEnrolled(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this._enrolledCache !== undefined && now - (this._enrolledCacheTime || 0) < 5000) {
      return this._enrolledCache;
    }
    try {
      const status = await this.getStatus();
      this._enrolledCache = Boolean(status?.ready && status?.profile_loaded);
      this._enrolledCacheTime = now;
      return this._enrolledCache;
    } catch {
      return false;
    }
  }

  isUserEnrolledSync() {
    return Boolean(this._enrolledCache);
  }

  clearEnrolledCache() {
    this._enrolledCache = undefined;
    this._enrolledCacheTime = 0;
  }
}

export const speakerVerificationService = new SpeakerVerificationService();
