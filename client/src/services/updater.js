import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

/**
 * Checks for application updates.
 * Returns the update object if available, otherwise null.
 */
export async function checkForAppUpdate() {
  try {
    const update = await check();
    if (update && update.available) {
      console.log(`Update available: ${update.version} from ${update.date}`);
      return update;
    }
    return null;
  } catch (error) {
    console.error('Failed to check for updates:', error);
    return null;
  }
}

/**
 * Downloads and installs an update.
 * @param {Object} update - The update object from check()
 * @param {Function} onProgress - Progress callback callback(downloaded, total)
 */
export async function installAppUpdate(update, onProgress) {
  try {
    let downloaded = 0;
    let contentLength = 0;

    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          contentLength = event.data.contentLength;
          if (onProgress) onProgress(0, contentLength);
          break;
        case 'Progress':
          downloaded += event.data.chunkLength;
          if (onProgress) onProgress(downloaded, contentLength);
          break;
        case 'Finished':
          console.log('Update download finished');
          break;
      }
    });

    console.log('Update installed, relaunching...');
    await relaunch();
  } catch (error) {
    console.error('Failed to install update:', error);
    throw error;
  }
}
