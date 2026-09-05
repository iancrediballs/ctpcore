// Desktop backend: a thin passthrough to the existing Rust commands.
// This file is the ONLY place in src/ that may import @tauri-apps.
import { invoke } from "@tauri-apps/api/core";
export const tauriBackend = {
    call(cmd, args) {
        return invoke(cmd, args);
    },
};
