// Serves generated video files to the editor page so the program monitor can play them.
// Only files inside the allowed output folders are served, and only video/audio types.
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
};

function encodeMediaPath(filePath) {
  return Buffer.from(String(filePath), 'utf8').toString('base64url');
}

function decodeMediaPath(token) {
  try {
    return Buffer.from(String(token), 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

// True when file is inside one of the roots and has an allowed extension.
function isAllowedMedia(filePath, roots) {
  if (!filePath || !MIME[path.extname(filePath).toLowerCase()]) return false;
  const resolved = path.resolve(filePath);
  return roots.some((root) => {
    const rel = path.relative(path.resolve(root), resolved);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

// Parses a Range header such as "bytes=0-99", "bytes=100-", or "bytes=-50".
// Returns { start, end }, or 'invalid' when the range cannot be satisfied.
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match) return 'invalid';
  let start;
  let end;
  if (match[1] === '' && match[2] === '') return 'invalid';
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

// Request handler for URLs of the form /media/<encoded path>. getRoots returns the allowed folders.
function createMediaHandler(getRoots) {
  return function handleMedia(req, res) {
    const token = req.url.slice('/media/'.length).split('?')[0];
    const filePath = decodeMediaPath(token);
    if (!filePath || !isAllowedMedia(filePath, getRoots())) {
      res.writeHead(404);
      return res.end('Not found');
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const size = stat.size;
      const type = MIME[path.extname(filePath).toLowerCase()];
      const range = req.headers.range;
      if (!range) {
        res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
        return fs.createReadStream(filePath).pipe(res);
      }
      const r = parseRange(range, size);
      if (r === 'invalid') {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${r.start}-${r.end}/${size}`,
        'Content-Length': r.end - r.start + 1,
      });
      return fs.createReadStream(filePath, { start: r.start, end: r.end }).pipe(res);
    });
  };
}

module.exports = { encodeMediaPath, decodeMediaPath, isAllowedMedia, parseRange, createMediaHandler };
