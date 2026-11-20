// Self-contained .zd project archive format for Zaude (similar to a .dwg bundle).
// Bundles the project JSON (timeline, clips, filters, HSL, transitions, bin metadata)
// AND all referenced video/audio files into a single portable .zd file using streaming I/O
// so saving/opening multi-gigabyte projects uses minimal RAM.
//
// Binary layout:
//   [0..7]   Magic: "ZAUDEZD1" (8 bytes ASCII)
//   [8..15]  Manifest byte length (BigUInt64LE)
//   [16..]   UTF-8 JSON manifest: { version: 1, project, assets: [{ id, name, size, offset }] }
//   [..]     Concatenated raw asset bytes in exact manifest order
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAGIC = Buffer.from('ZAUDEZD1', 'ascii');
const HEADER_LEN = 16;

function streamCopyRange(srcPath, start, end, outStream) {
  return new Promise((resolve, reject) => {
    const opts = end !== null ? { start, end, highWaterMark: 64 * 1024 } : { highWaterMark: 64 * 1024 };
    const rs = fs.createReadStream(srcPath, opts);
    rs.on('error', reject);
    rs.on('end', resolve);
    rs.pipe(outStream, { end: false });
  });
}

function sanitizeAssetName(name, fallback) {
  const base = path.basename(String(name || fallback || 'media.bin')).replace(/[^A-Za-z0-9._ -]/g, '_');
  return base || 'media.bin';
}

// Collects all unique existing media files referenced by clips and bin media,
// and returns { assets, pathToAssetId }.
function collectAssets(clips, media) {
  const pathToAssetId = new Map();
  const assets = [];
  let idx = 0;

  const register = (filePath, name) => {
    if (!filePath || typeof filePath !== 'string') return;
    const resolved = path.resolve(filePath);
    if (pathToAssetId.has(resolved)) return;
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    const id = `m${idx++}`;
    pathToAssetId.set(resolved, id);
    assets.push({
      id,
      name: sanitizeAssetName(name || path.basename(resolved), `${id}.bin`),
      sourcePath: resolved,
      size: stat.size,
    });
  };

  for (const c of Array.isArray(clips) ? clips : []) {
    if (c && c.path) register(c.path, c.name);
  }
  for (const m of Array.isArray(media) ? media : []) {
    if (m && m.path) register(m.path, m.name);
  }
  return { assets, pathToAssetId };
}

// Writes a self-contained .zd archive atomically via streaming.
async function writeZdFile(outPath, projectData) {
  const resolvedOut = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });

  const clips = Array.isArray(projectData.clips) ? projectData.clips : [];
  const media = Array.isArray(projectData.media) ? projectData.media : [];
  const { assets, pathToAssetId } = collectAssets(clips, media);

  const mapPath = (p) => {
    if (!p || typeof p !== 'string') return p;
    const id = pathToAssetId.get(path.resolve(p));
    return id ? `zd://${id}` : p;
  };

  let offset = 0;
  const manifestAssets = assets.map((a) => {
    const entry = { id: a.id, name: a.name, size: a.size, offset };
    offset += a.size;
    return entry;
  });

  const manifest = {
    version: 1,
    savedAt: new Date().toISOString(),
    project: {
      name: projectData.name || path.basename(resolvedOut, '.zd') || 'Untitled',
      format: projectData.format || 'MP4',
      resolution: projectData.resolution || '1920 × 1080',
      clips: clips.map((c) => (c && c.path ? { ...c, path: mapPath(c.path) } : { ...c })),
      media: media.map((m) => (m && m.path ? { ...m, path: mapPath(m.path) } : { ...m })),
    },
    assets: manifestAssets,
  };

  const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeBigUInt64LE(BigInt(manifestBuf.length), 8);

  const tmpPath = `${resolvedOut}.${process.pid}.tmp`;
  const ws = fs.createWriteStream(tmpPath, { highWaterMark: 64 * 1024 });

  try {
    await new Promise((resolve, reject) => {
      ws.once('error', reject);
      ws.write(header);
      ws.write(manifestBuf, (err) => (err ? reject(err) : resolve()));
    });

    for (const a of assets) {
      if (a.size > 0) {
        await streamCopyRange(a.sourcePath, 0, a.size - 1, ws);
      }
    }

    await new Promise((resolve, reject) => {
      ws.once('error', reject);
      ws.end(resolve);
    });

    fs.renameSync(tmpPath, resolvedOut);
    return {
      ok: true,
      filePath: resolvedOut,
      assetCount: assets.length,
      totalBytes: HEADER_LEN + manifestBuf.length + offset,
    };
  } catch (err) {
    ws.destroy();
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return { ok: false, error: err.message || String(err) };
  }
}

// Reads only the header + JSON manifest of a .zd file.
function readZdManifest(zdPath) {
  const fd = fs.openSync(zdPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size < HEADER_LEN) throw new Error('File is too small to be a valid .zd project.');
    const header = Buffer.alloc(HEADER_LEN);
    fs.readSync(fd, header, 0, HEADER_LEN, 0);
    if (!header.subarray(0, 8).equals(MAGIC)) {
      throw new Error('Not a valid Zaude (.zd) project file.');
    }
    const manifestLen = Number(header.readBigUInt64LE(8));
    if (!Number.isFinite(manifestLen) || manifestLen <= 0 || HEADER_LEN + manifestLen > stat.size) {
      throw new Error('The .zd project header is corrupted.');
    }
    const manifestBuf = Buffer.alloc(manifestLen);
    fs.readSync(fd, manifestBuf, 0, manifestLen, HEADER_LEN);
    const manifest = JSON.parse(manifestBuf.toString('utf8'));
    if (!manifest || typeof manifest !== 'object' || !manifest.project || !Array.isArray(manifest.assets)) {
      throw new Error('The .zd project manifest is invalid.');
    }
    return { manifest, payloadStart: HEADER_LEN + manifestLen, fileSize: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

// Opens a .zd archive, streams embedded media files into extractRoot/<sessionHash>/,
// and returns the hydrated project + media with real local file paths.
async function readZdFile(zdPath, extractRoot) {
  try {
    const resolvedZd = path.resolve(zdPath);
    const { manifest, payloadStart, fileSize } = readZdManifest(resolvedZd);
    const stat = fs.statSync(resolvedZd);
    const hash = crypto.createHash('sha1').update(`${resolvedZd}|${stat.mtimeMs}|${stat.size}`).digest('hex').slice(0, 12);
    const sessionDir = path.join(path.resolve(extractRoot), `zd-${hash}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    const idToPath = new Map();
    for (const a of manifest.assets) {
      const start = payloadStart + a.offset;
      const end = start + a.size - 1;
      if (a.size < 0 || start + a.size > fileSize) {
        throw new Error(`Embedded media "${a.name}" is truncated or corrupted.`);
      }
      const safeName = `${a.id}-${sanitizeAssetName(a.name, `${a.id}.bin`)}`;
      const destPath = path.join(sessionDir, safeName);
      // Reuse already-extracted file if exact size matches
      let needsExtract = true;
      try {
        if (fs.statSync(destPath).size === a.size) needsExtract = false;
      } catch { /* not extracted yet */ }

      if (needsExtract) {
        if (a.size === 0) {
          fs.writeFileSync(destPath, Buffer.alloc(0));
        } else {
          const ws = fs.createWriteStream(destPath, { highWaterMark: 64 * 1024 });
          await streamCopyRange(resolvedZd, start, end, ws);
          await new Promise((resolve, reject) => {
            ws.once('error', reject);
            ws.end(resolve);
          });
        }
      }
      idToPath.set(`zd://${a.id}`, destPath);
    }

    const unmapPath = (p) => (typeof p === 'string' && idToPath.has(p) ? idToPath.get(p) : p);
    const proj = manifest.project;
    const clips = (Array.isArray(proj.clips) ? proj.clips : []).map((c) => (c && c.path ? { ...c, path: unmapPath(c.path) } : { ...c }));
    const media = (Array.isArray(proj.media) ? proj.media : []).map((m) => (m && m.path ? { ...m, path: unmapPath(m.path) } : { ...m }));

    return {
      ok: true,
      filePath: resolvedZd,
      sessionDir,
      project: {
        name: proj.name || path.basename(resolvedZd, '.zd'),
        format: proj.format || 'MP4',
        resolution: proj.resolution || '1920 × 1080',
        clips,
        media,
      },
      assetCount: manifest.assets.length,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = { MAGIC, writeZdFile, readZdManifest, readZdFile };
