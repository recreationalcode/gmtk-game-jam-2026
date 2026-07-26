/**
 * A minimal ZIP writer, in pure Node.
 *
 * This exists instead of `execFileSync('zip', ...)` because packaging now runs
 * inside the Vercel build as well as on a laptop. A missing `zip` binary in a
 * build image would fail the whole deployment — taking the playable game down
 * over a packaging convenience — and `zip` is also absent on a stock Windows
 * checkout. `node:zlib` is always there.
 *
 * Scope is deliberately small: deflate or store, no directory entries, no
 * zip64, no encryption. The bundle is a handful of files under a megabyte, and
 * itch.io's extractor (Go's archive/zip) is happy without directory entries.
 */
import { deflateRawSync } from 'node:zlib';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/** Bit 11: names are UTF-8. Set unconditionally — ASCII names are valid UTF-8. */
const FLAG_UTF8 = 0x0800;

/**
 * A fixed DOS timestamp (1980-01-01 00:00, the ZIP epoch) rather than real
 * mtimes, so identical dist/ contents always produce a byte-identical archive.
 * On jam day "is this actually a new build?" is a question worth being able to
 * answer by comparing two hashes.
 */
const DOS_TIME = 0;
const DOS_DATE = (1980 - 1980) << 9 | (1 << 5) | 1;

/** External attributes: regular file, rw-r--r--, so extraction gives sane modes. */
const UNIX_MODE = (0o100644 << 16) >>> 0;

/** Version made by: UNIX (high byte 3), spec 3.0 — required for UNIX_MODE to be read. */
const MADE_BY = 0x031e;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a ZIP archive in memory.
 *
 * @param {Array<{ name: string, data: Buffer }>} entries Archive-relative
 *   POSIX paths and their contents. Order is preserved.
 * @returns {Buffer} The complete archive.
 */
export function createZip(entries) {
  /** @type {Buffer[]} */
  const body = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const crc = crc32(raw);

    // Store rather than deflate when compression does not pay — true for the
    // already-compressed assets a game bundle tends to carry.
    const deflated = deflateRawSync(raw, { level: 9 });
    const compressed = deflated.length < raw.length;
    const payload = compressed ? deflated : raw;
    const method = compressed ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4); // version needed to extract: 2.0
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    body.push(local, name, payload);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(CENTRAL_HEADER, 0);
    dir.writeUInt16LE(MADE_BY, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(FLAG_UTF8, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // no extra field
    dir.writeUInt16LE(0, 32); // no comment
    dir.writeUInt16LE(0, 34); // disk number
    dir.writeUInt16LE(0, 36); // internal attributes
    dir.writeUInt32LE(UNIX_MODE, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + payload.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no archive comment

  return Buffer.concat([...body, directory, end]);
}
