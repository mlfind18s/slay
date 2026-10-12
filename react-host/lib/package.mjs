// Full package validation: archive structure -> manifest -> entry/icon. Mirrors PackageValidator.kt.
import { LIMITS, MANIFEST_NAME, PackageError } from './errors.mjs';
import { readZip } from './zip.mjs';
import { validateManifest } from './manifest.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(data) {
  return data.length >= 24 && data.subarray(0, 8).equals(PNG_SIGNATURE) && data.toString('latin1', 12, 16) === 'IHDR';
}

/**
 * Returns { ok: true, manifest, warnings, files, unpackedBytes } or
 * { ok: false, error: { code, message, field? } }.
 */
export function validatePackage(zip, { limits = LIMITS, hostVersion } = {}) {
  try {
    if (zip.length > limits.maxZipBytes) {
      throw new PackageError('ZIP_TOO_LARGE', `Архів більший за ${limits.maxZipBytes} байт`);
    }
    const files = readZip(zip, limits);
    const manifestData = files.get(MANIFEST_NAME);
    if (!manifestData) {
      const nested = [...files.keys()].find((p) => p.split('/').length === 2 && p.endsWith('/' + MANIFEST_NAME));
      if (nested) {
        throw new PackageError('MANIFEST_IN_SUBFOLDER', `Маніфест знайдено в "${nested}", а має бути в корені ZIP. Запакуйте вміст папки, а не саму папку`);
      }
      throw new PackageError('MANIFEST_MISSING', `У корені архіву немає ${MANIFEST_NAME}`);
    }
    if (manifestData.length > limits.maxManifestBytes) {
      throw new PackageError('MANIFEST_TOO_LARGE', `${MANIFEST_NAME} більший за ${limits.maxManifestBytes} байт`);
    }
    let parsed;
    try {
      let text = new TextDecoder('utf-8', { fatal: true }).decode(manifestData);
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      parsed = JSON.parse(text);
    } catch {
      throw new PackageError('MANIFEST_INVALID_JSON', `${MANIFEST_NAME} не є коректним JSON у UTF-8`);
    }
    const { manifest, warnings } = validateManifest(parsed, { hostVersion });
    if (!files.has(manifest.entry)) {
      throw new PackageError('ENTRY_MISSING', `Файл ${manifest.entry} відсутній у корені архіву`);
    }
    if (manifest.icon) {
      const icon = files.get(manifest.icon);
      if (!icon) warnings.push({ code: 'ICON_MISSING', message: `Іконку ${manifest.icon} не знайдено, буде стандартна` });
      else if (!isPng(icon)) warnings.push({ code: 'ICON_NOT_PNG', message: `${manifest.icon} не є PNG, буде стандартна іконка` });
    }
    let unpackedBytes = 0;
    for (const data of files.values()) unpackedBytes += data.length;
    return { ok: true, manifest, warnings, files, unpackedBytes };
  } catch (error) {
    if (error instanceof PackageError) {
      return { ok: false, error: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) } };
    }
    throw error;
  }
}
