/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dashboard URL for the shell's "back" arrow. Baked into the bundle: public, never a secret. */
  readonly VITE_DASHBOARD_URL?: string;
}
