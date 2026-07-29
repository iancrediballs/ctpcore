// Desktop backend: a thin passthrough to the existing Rust commands.
// This file is the ONLY place in src/ that may import @tauri-apps.
import { invoke } from "@tauri-apps/api/core";
import type { Backend } from "./backend";

export const tauriBackend: Backend = {
  call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    return invoke<T>(cmd, args);
  },
};
