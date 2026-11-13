import { invoke } from '@tauri-apps/api/core';

export const Invoke = invoke;
export const isTauri = () => window.__TAURI_INTERNALS__ != null;
