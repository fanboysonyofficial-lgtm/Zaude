// Update support for the desktop app. Checks the newest GitHub release over HTTPS,
// downloads the build for this platform, and
// swaps it in after the app closes. Pure helpers are exported for tests; nothing here imports electron.
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const REPO = 'fanboysonyofficial-lgtm/Zaude';
const MIN_BUILD_BYTES = 1024 * 1024;
const USER_AGENT = 'Zaude-update-check';

// "v1.2.3" or "1.2.3" -> [1, 2, 3]; anything else -> null
function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// Picks this platform's build from a release's asset list. Matches by suffix so the
// version number in the file name does not matter.
function pickAsset(assets, platform) {
  const suffix = platform === 'win32' ? '-windows-x64.exe' : platform === 'linux' ? '-linux-x86_64.AppImage' : null;
  if (!suffix || !Array.isArray(assets)) return null;
  return assets.find((a) => a && typeof a.name === 'string' && a.name.endsWith(suffix)) || null;
}

// The first bytes of a real build: ELF for AppImage, MZ for a Windows .exe.
function looksLikeBuild(platform, head) {
  if (!head || head.length < 4) return false;
  if (platform === 'win32') return head[0] === 0x4d && head[1] === 0x5a;
  return head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
}

function shQuote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

function psQuote(text) {
  return "'" + String(text).replace(/'/g, "''") + "'";
}

// Shell script for Linux. Waits for the running app to exit, copies the new AppImage over the
// old one, and starts it again. If the copy fails, the old version is started so nothing is lost.
function linuxScript({ pid, newFile, target, logFile }) {
  return [
    '#!/bin/sh',
    `PID=${Number(pid)}`,
    `NEW=${shQuote(newFile)}`,
    `TARGET=${shQuote(target)}`,
    `LOG=${shQuote(logFile)}`,
    'i=0',
    'while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 240 ]; do sleep 0.5; i=$((i+1)); done',
    'if cp "$NEW" "$TARGET.new" && chmod 755 "$TARGET.new" && mv -f "$TARGET.new" "$TARGET"; then',
    '  echo "updated $(date)" >> "$LOG"',
    'else',
    '  echo "update copy failed $(date)" >> "$LOG"',
    'fi',
    'rm -f "$NEW"',
    '"$TARGET" >/dev/null 2>&1 &',
    '',
  ].join('\n');
}

// PowerShell script for Windows. Same idea: wait for the app to close, replace the portable .exe,
// start it again. Written with a UTF-8 byte order mark so Windows PowerShell reads non-ASCII paths.
function windowsScript({ pid, newFile, target, logFile }) {
  const body = [
    '$ErrorActionPreference = "Stop"',
    `$pidToWait = ${Number(pid)}`,
    `$new = ${psQuote(newFile)}`,
    `$target = ${psQuote(target)}`,
    `$log = ${psQuote(logFile)}`,
    'try { Wait-Process -Id $pidToWait -Timeout 120 -ErrorAction SilentlyContinue } catch {}',
    'Start-Sleep -Milliseconds 500',
    'try {',
    '  Copy-Item -LiteralPath $new -Destination ($target + ".new") -Force',
    '  Move-Item -LiteralPath ($target + ".new") -Destination $target -Force',
    '  Add-Content -LiteralPath $log -Value ("updated " + (Get-Date))',
    '} catch {',
    '  Add-Content -LiteralPath $log -Value ("update copy failed: " + $_.Exception.Message)',
    '}',
    'Remove-Item -LiteralPath $new -ErrorAction SilentlyContinue',
    'Start-Process -FilePath $target',
    '',
  ].join('\r\n');
  return '﻿' + body;
}

// Asks GitHub for the newest published release over HTTPS. No GitHub CLI or sign-in is needed,
// because the repository is public. Resolves to { ok, tag, version, assets } or { ok: false, error }.
async function fetchLatestRelease(repo = REPO) {
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    return { ok: false, error: 'Could not reach GitHub. Check the internet connection.' };
  }
  if (res.status === 404) return { ok: false, error: 'No release has been published yet.' };
  if (res.status === 403 || res.status === 429) return { ok: false, error: 'GitHub is limiting requests. Try again later.' };
  if (!res.ok) return { ok: false, error: `GitHub answered ${res.status}.` };
  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: 'GitHub sent a reply Zaude could not read.' };
  }
  const version = parseVersion(data.tag_name) ? data.tag_name.replace(/^v/, '') : null;
  if (!version) return { ok: false, error: `Release tag "${data.tag_name}" is not a version like v1.2.3.` };
  const assets = (Array.isArray(data.assets) ? data.assets : []).map((a) => ({
    name: a.name,
    size: a.size,
    url: a.browser_download_url,
  }));
  return { ok: true, tag: data.tag_name, version, assets };
}

// Downloads the platform build into dir and checks that it is a real program of the right size.
async function downloadBuild({ asset, platform, dir }) {
  if (!asset || !asset.url) throw new Error('This release has no download link for this system.');
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, asset.name);
  let res;
  try {
    res = await fetch(asset.url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
  } catch {
    throw new Error('Could not download the update. Check the internet connection.');
  }
  if (!res.ok || !res.body) throw new Error(`The download failed (GitHub answered ${res.status}).`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
  const stat = await fs.promises.stat(file);
  if (stat.size < MIN_BUILD_BYTES) throw new Error('The downloaded file is too small to be Zaude.');
  const fh = await fs.promises.open(file, 'r');
  const head = Buffer.alloc(4);
  await fh.read(head, 0, 4, 0);
  await fh.close();
  if (!looksLikeBuild(platform, head)) throw new Error('The downloaded file is not a program for this system.');
  return file;
}

// Where the running app lives on disk. AppImage sets APPIMAGE; the electron-builder portable
// .exe sets PORTABLE_EXECUTABLE_FILE. Running from source sets neither, so updates are refused.
function installTarget(platform, env) {
  if (platform === 'linux') return env.APPIMAGE || null;
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_FILE || null;
  return null;
}

module.exports = {
  REPO,
  parseVersion,
  isNewer,
  pickAsset,
  looksLikeBuild,
  linuxScript,
  windowsScript,
  fetchLatestRelease,
  downloadBuild,
  installTarget,
};
