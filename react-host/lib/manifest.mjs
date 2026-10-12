// react-host.json schema v1 (docs/package-format.md), mirrors Manifest.kt.
import { PackageError } from './errors.mjs';
import { parseSemVer, compareSemVer } from './semver.mjs';
import { checkEntryPath } from './zip.mjs';

export const APP_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const KNOWN_FIELDS = new Set(['schemaVersion', 'appId', 'name', 'version', 'description', 'entry', 'icon', 'minHostVersion']);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const invalid = (field, message) => new PackageError('MANIFEST_FIELD_INVALID', `Поле "${field}": ${message}`, field);
const codePoints = (s) => [...s].length;

/**
 * Validates a parsed manifest object. Returns { manifest, warnings }.
 * hostVersion (optional) enables the minHostVersion compatibility check.
 */
export function validateManifest(value, { hostVersion } = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PackageError('MANIFEST_INVALID_JSON', 'Маніфест має бути JSON-об’єктом');
  }
  const warnings = [];
  if (value.schemaVersion === undefined) throw invalid('schemaVersion', 'обов’язкове');
  if (value.schemaVersion !== 1) {
    throw new PackageError('MANIFEST_SCHEMA_UNSUPPORTED', `Невідома версія схеми маніфесту: ${JSON.stringify(value.schemaVersion)}`, 'schemaVersion');
  }

  const { appId, name, version, description, entry, icon, minHostVersion } = value;
  if (typeof appId !== 'string') throw invalid('appId', 'обов’язковий рядок');
  if (appId.length > 120 || !APP_ID.test(appId)) {
    throw invalid('appId', 'малі латинські літери, цифри й дефіс, сегменти через крапку, кожен починається з літери (до 120 символів)');
  }
  if (typeof name !== 'string') throw invalid('name', 'обов’язковий рядок');
  const trimmedName = name.trim();
  if (codePoints(trimmedName) < 1 || codePoints(trimmedName) > 80 || CONTROL.test(name)) throw invalid('name', 'від 1 до 80 символів');
  if (typeof version !== 'string' || !parseSemVer(version)) throw invalid('version', 'має бути SemVer, наприклад 0.1.0');
  if (description !== undefined && (typeof description !== 'string' || codePoints(description) > 500)) {
    throw invalid('description', 'рядок до 500 символів');
  }
  if (entry !== 'index.html') throw invalid('entry', 'у схемі 1 має дорівнювати "index.html"');
  let iconPath;
  if (icon !== undefined) {
    if (typeof icon !== 'string') throw invalid('icon', 'відносний шлях до PNG');
    try {
      iconPath = checkEntryPath(icon);
    } catch {
      throw invalid('icon', 'небезпечний або некоректний шлях');
    }
    if (icon.endsWith('/') || !/\.png$/i.test(icon)) throw invalid('icon', 'очікується файл .png');
  }
  if (minHostVersion !== undefined) {
    if (typeof minHostVersion !== 'string' || !parseSemVer(minHostVersion)) throw invalid('minHostVersion', 'має бути SemVer');
    if (hostVersion && compareSemVer(minHostVersion, hostVersion) > 0) {
      throw new PackageError('HOST_VERSION_TOO_LOW', `Потрібна версія React Host ${minHostVersion} або новіша (встановлено ${hostVersion})`, 'minHostVersion');
    }
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push({ code: 'MANIFEST_UNKNOWN_FIELD', message: `Невідоме поле "${key}" проігноровано` });
  }
  return {
    manifest: {
      schemaVersion: 1,
      appId,
      name: trimmedName,
      version,
      description: description ?? null,
      entry,
      icon: iconPath ?? null,
      minHostVersion: minHostVersion ?? null,
    },
    warnings,
  };
}
