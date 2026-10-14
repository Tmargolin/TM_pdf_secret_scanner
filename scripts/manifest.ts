// Builds the final manifest from the template in /manifest.json.
// Release and dev builds differ only as described in DESIGN.md §3.1 (dev build).

export type BuildMode = 'release' | 'dev';

export interface Manifest {
  version: string;
  host_permissions?: string[];
  [key: string]: unknown;
}

/** Host permission added to dev builds only (local test pages and mock API). */
export const DEV_HOST_PERMISSION = 'http://localhost/*';

export function createManifest(
  template: Manifest,
  options: { mode: BuildMode; version: string },
): Manifest {
  const manifest: Manifest = structuredClone(template);
  manifest.version = options.version;

  if (options.mode === 'dev') {
    manifest.host_permissions = [...(manifest.host_permissions ?? []), DEV_HOST_PERMISSION];
  }
  return manifest;
}
