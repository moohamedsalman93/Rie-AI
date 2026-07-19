import { invoke, isTauri } from "@tauri-apps/api/core";

export { isTauri };

/**
 * @returns {Promise<{ client_latitude?: number, client_longitude?: number, client_location_accuracy_m?: number }>}
 */
export async function getNativeLocationPayload() {
  return invoke("get_native_location");
}

/** @returns {Promise<void>} */
export async function startNativeRecording() {
  await invoke("start_native_recording");
}

/**
 * @returns {Promise<Blob>}
 */
export async function stopNativeRecording() {
  const bytes = await invoke("stop_native_recording");
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new Blob([data], { type: "audio/wav" });
}
