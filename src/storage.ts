import {
  DEFAULT_RENDER_OPTIONS,
  RENDER_OPTIONS_STORAGE_KEY,
  normalizeRenderOptions,
  type RenderOptions,
} from "./settings";

type StoredRenderOptions = Partial<Record<keyof RenderOptions, unknown>>;

export function readRenderOptions(): Promise<RenderOptions> {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(
      { [RENDER_OPTIONS_STORAGE_KEY]: DEFAULT_RENDER_OPTIONS },
      (items: Record<string, unknown>) => {
        const error = chrome.runtime.lastError;

        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(
          normalizeRenderOptions(
            items[RENDER_OPTIONS_STORAGE_KEY] as StoredRenderOptions,
          ),
        );
      },
    );
  });
}

export function writeRenderOptions(options: RenderOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(
      {
        [RENDER_OPTIONS_STORAGE_KEY]: normalizeRenderOptions(options),
      },
      () => {
        const error = chrome.runtime.lastError;

        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve();
      },
    );
  });
}
