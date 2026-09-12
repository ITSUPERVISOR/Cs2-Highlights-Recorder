import type { ReelApi } from "../../../electron/preload";

declare global {
  interface Window {
    reel: ReelApi;
  }
}

export {};
