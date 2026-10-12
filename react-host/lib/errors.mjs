// Error codes are shared with the Android validator (PackageError.kt) and the fixtures.
export class PackageError extends Error {
  constructor(code, message, field) {
    super(message);
    this.code = code;
    if (field) this.field = field;
  }
}

export const LIMITS = Object.freeze({
  maxZipBytes: 25 * 1024 * 1024,
  maxUnpackedBytes: 100 * 1024 * 1024,
  maxEntries: 5000,
  maxManifestBytes: 64 * 1024,
});

export const MANIFEST_NAME = 'react-host.json';
export const ASSET_NAME = 'react-host-app.zip';
