// Strict ZIP reader and deterministic writer (no dependencies, Node >= 22).
// The reader mirrors android/app/.../pkg/ZipReader.kt: both must accept and reject the
// same archives (see tools/fixtures/expectations.json).
import { inflateRawSync, deflateRawSync, crc32 } from 'node:zlib';
import { PackageError } from './errors.mjs';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

export const MAX_PATH_BYTES = 512;

function corrupt(detail) {
  return new PackageError('ZIP_CORRUPT', `Архів пошкоджений: ${detail}`);
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Validates a package-relative path from a ZIP entry. Returns the path without a trailing
 * slash, or throws ZIP_UNSAFE_PATH.
 */
export function checkEntryPath(name) {
  const unsafe = (why) => new PackageError('ZIP_UNSAFE_PATH', `Небезпечний шлях у архіві "${name}": ${why}`);
  if (name.length === 0) throw unsafe('порожнє ім’я');
  if (Buffer.byteLength(name, 'utf8') > MAX_PATH_BYTES) throw unsafe('задовгий шлях');
  if (name.includes('\\')) throw unsafe('зворотна коса риска');
  if (name.startsWith('/')) throw unsafe('абсолютний шлях');
  if (/^[A-Za-z]:/.test(name)) throw unsafe('літера диска');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw unsafe('керівні символи');
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  for (const segment of trimmed.split('/')) {
    if (segment === '') throw unsafe('порожній сегмент');
    if (segment === '.' || segment === '..') throw unsafe('сегмент "." або ".."');
  }
  return trimmed;
}

/**
 * Parses the central directory and checks structure, paths and declared limits.
 * Returns entries sorted by local header offset; file data is not inflated yet.
 */
export function readCentralDirectory(buf, limits) {
  if (buf.length < 22) throw corrupt('замалий файл');
  const eocd = findEocd(buf);
  if (eocd < 0) throw corrupt('не знайдено кінець центрального каталогу');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) {
    throw new PackageError('ZIP64_UNSUPPORTED', 'ZIP64 не підтримується');
  }
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesOnDisk = buf.readUInt16LE(eocd + 8);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new PackageError('ZIP64_UNSUPPORTED', 'ZIP64 не підтримується');
  }
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) throw corrupt('багатотомні архіви не підтримуються');
  if (totalEntries > limits.maxEntries) {
    throw new PackageError('ZIP_TOO_MANY_ENTRIES', `Забагато записів: ${totalEntries} (максимум ${limits.maxEntries})`);
  }
  if (cdOffset + cdSize > eocd) throw corrupt('центральний каталог виходить за межі');

  const entries = [];
  const seen = new Map(); // lower-cased path -> kind
  let declaredTotal = 0;
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== SIG_CENTRAL) throw corrupt('неправильний запис центрального каталогу');
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameEnd = p + 46 + nameLen;
    if (nameEnd + extraLen + commentLen > cdOffset + cdSize) throw corrupt('запис виходить за межі каталогу');
    const nameBytes = buf.subarray(p + 46, nameEnd);
    p = nameEnd + extraLen + commentLen;

    if (flags & 0x0001) throw new PackageError('ZIP_ENCRYPTED', 'Зашифровані архіви не підтримуються');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new PackageError('ZIP64_UNSUPPORTED', 'ZIP64 не підтримується');
    }
    const utf8 = (flags & 0x0800) !== 0;
    if (!utf8 && nameBytes.some((b) => b > 0x7f)) {
      throw new PackageError('ZIP_UNSAFE_PATH', 'Імена файлів не в UTF-8 (встановіть прапорець UTF-8)');
    }
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    const path = checkEntryPath(name);
    let isDirectory = name.endsWith('/');

    if (madeBy >> 8 === 3) {
      const type = (externalAttrs >>> 16) & S_IFMT;
      if (type === S_IFLNK) throw new PackageError('ZIP_SYMLINK', `Символічні посилання заборонені: ${name}`);
      if (type === S_IFDIR) isDirectory = true;
      else if (type !== 0 && type !== S_IFREG) throw new PackageError('ZIP_SPECIAL_FILE', `Спеціальні файли заборонені: ${name}`);
    }
    if (isDirectory && (size !== 0 || compressedSize !== 0)) throw corrupt(`каталог із даними: ${name}`);
    if (!isDirectory && method !== 0 && method !== 8) {
      throw new PackageError('ZIP_METHOD_UNSUPPORTED', `Метод стиснення ${method} не підтримується (${name})`);
    }

    const key = path.normalize('NFC').toLowerCase();
    const kind = isDirectory ? 'dir' : 'file';
    if (seen.has(key)) {
      // Repeating a directory entry is harmless; anything else is a duplicate path.
      if (!(kind === 'dir' && seen.get(key) === 'dir')) {
        throw new PackageError('ZIP_DUPLICATE_PATH', `Повторюваний шлях: ${name}`);
      }
      continue;
    }
    seen.set(key, kind);
    declaredTotal += size;
    entries.push({ name, path, isDirectory, method, crc, compressedSize, size, localOffset });
  }
  if (p !== cdOffset + cdSize) throw corrupt('розмір центрального каталогу не збігається');

  // A file must not also be used as a parent directory ("a" and "a/b").
  for (const entry of entries) {
    const parts = entry.path.normalize('NFC').toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.get(parts.slice(0, i).join('/')) === 'file') {
        throw new PackageError('ZIP_DUPLICATE_PATH', `Шлях використано і як файл, і як каталог: ${entry.name}`);
      }
    }
  }
  if (declaredTotal > limits.maxUnpackedBytes) {
    throw new PackageError('ZIP_UNPACKED_TOO_LARGE', `Розпакований вміст перевищує ${limits.maxUnpackedBytes} байт`);
  }

  // Local headers: inside the archive, before the central directory, not overlapping.
  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 0; i < byOffset.length; i++) {
    const e = byOffset[i];
    const next = i + 1 < byOffset.length ? byOffset[i + 1].localOffset : cdOffset;
    if (e.localOffset + 30 > cdOffset || buf.readUInt32LE(e.localOffset) !== SIG_LOCAL) throw corrupt(`немає локального заголовка для ${e.name}`);
    const localNameLen = buf.readUInt16LE(e.localOffset + 26);
    const localExtraLen = buf.readUInt16LE(e.localOffset + 28);
    e.dataOffset = e.localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = e.dataOffset + e.compressedSize;
    if (dataEnd > next) throw new PackageError('ZIP_OVERLAP', `Записи архіву перекриваються (${e.name})`);
    const localName = buf.subarray(e.localOffset + 30, e.localOffset + 30 + localNameLen);
    if (!localName.equals(Buffer.from(e.name, 'utf8'))) throw corrupt(`ім’я в локальному заголовку не збігається (${e.name})`);
  }
  return byOffset;
}

/** Inflates one entry, enforcing its declared size, CRC and the running total. */
export function readEntryData(buf, entry, budget) {
  const raw = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let data;
  if (entry.method === 0) {
    data = raw;
  } else {
    try {
      data = inflateRawSync(raw, { maxOutputLength: entry.size + 1 });
    } catch (error) {
      if (error.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new PackageError('ZIP_SIZE_MISMATCH', `Фактичний розмір ${entry.name} більший за заявлений`);
      }
      throw corrupt(`не вдалося розпакувати ${entry.name}`);
    }
  }
  if (data.length !== entry.size) throw new PackageError('ZIP_SIZE_MISMATCH', `Фактичний розмір ${entry.name} не збігається із заявленим`);
  budget.used += data.length;
  if (budget.used > budget.max) throw new PackageError('ZIP_UNPACKED_TOO_LARGE', `Розпакований вміст перевищує ${budget.max} байт`);
  if (crc32(data) >>> 0 !== entry.crc >>> 0) throw new PackageError('ZIP_CRC_MISMATCH', `Контрольна сума ${entry.name} не збігається`);
  return data;
}

/** Reads and fully verifies an archive. Returns Map(path -> Buffer) for files only. */
export function readZip(buf, limits) {
  const entries = readCentralDirectory(buf, limits);
  const budget = { used: 0, max: limits.maxUnpackedBytes };
  const files = new Map();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    files.set(entry.path, readEntryData(buf, entry, budget));
  }
  return files;
}

// ---------------------------------------------------------------------------------------
// Writer. Deterministic: sorted input expected, fixed timestamps, UTF-8 names.

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

/**
 * entries: [{ name, data?, mode?, method?, rawName? }]
 * Low-level on purpose (used for test fixtures too): it does not validate names.
 * `overrides` lets fixtures corrupt individual header fields.
 */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = entry.rawName ?? Buffer.from(entry.name, 'utf8');
    const data = entry.data ?? Buffer.alloc(0);
    const isDir = entry.name?.endsWith('/') ?? false;
    let method = entry.method ?? (isDir || data.length === 0 ? 0 : 8);
    let payload = data;
    if (method === 8) {
      const deflated = deflateRawSync(data, { level: 9 });
      if (entry.method === undefined && deflated.length >= data.length) method = 0;
      else payload = deflated;
    }
    const o = entry.overrides ?? {};
    const crc = o.crc ?? crc32(data) >>> 0;
    const size = o.size ?? data.length;
    const flags = o.flags ?? 0x0800;
    const mode = entry.mode ?? (isDir ? 0o040755 : 0o100644);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const localOffset = o.localOffset ?? offset;
    locals.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE((3 << 8) | 30, 4); // made by Unix, spec 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
