import { invoke, isTauri } from "@tauri-apps/api/core";

export { isTauri };

/**
 * @returns {Promise<{ client_latitude?: number, client_longitude?: number, client_location_accuracy_m?: number }>}
 */
export async function getNativeLocationPayload() {
  return invoke("get_native_location");
}
