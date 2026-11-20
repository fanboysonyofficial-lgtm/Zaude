// Desktop shell for Zaude. Starts a tiny local server for the editor files and opens them in a window.
// A local server is used because browsers refuse ES module scripts loaded from file:// URLs.
const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');

// Enable hardware GPU rasterization, WebGL, and accelerated video decoding on Linux/Windows,
// while capping the JS heap so system RAM stays lean on 16 GB laptops.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=1536');
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'AcceleratedVideoDecodeLinuxGL,AcceleratedVideoDecodeLinuxZeroCopyGL,VaapiVideoDecoder,CanvasOopRasterization');
}
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const remote = require('./remote-analysis.cjs');
const media = require('./media.cjs');
const project = require('./project.cjs');
const waveform = require('./waveform.cjs');
const zdFormat = require('./zd-format.cjs');
const render = require('./render.cjs');
const updater = require('./updater.cjs');
const { spawn } = require('node:child_process');
const mediaHandler = media.createMediaHandler(() => mediaRoots());
let serverPort = 0;

const ROOT = path.join(__dirname, '..');
const ALLOWED = /^(index\.html|styles\.css|src\/.+\.js)$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/media/')) return mediaHandler(req, res);
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!ALLOWED.test(rel)) {
        res.writeHead(404);
        return res.end('Not found');
      }
      fs.readFile(path.join(ROOT, rel), (err, data) => {
        if (err) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------- remote machines ----------
// Saved in the app's data folder as JSON. Each machine keeps its last analysis report,
// so the app knows its capabilities on the next start without connecting again.

const storeFile = () => path.join(app.getPath('userData'), 'remote-machines.json');

function loadMachines() {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return Array.isArray(data.machines) ? data.machines : [];
  } catch {
    return [];
  }
}

function saveMachines(machines) {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  const tmp = storeFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, machines }, null, 2));
  fs.renameSync(tmp, storeFile());
}

function registerRemoteHandlers() {
  ipcMain.handle('remote:list', () => loadMachines());

  ipcMain.handle('remote:add', (_e, input) => {
    const checked = remote.validateMachineInput(input);
    if (!checked.ok) return checked;
    const machine = { id: crypto.randomUUID(), ...checked.value, report: null, analyzedAt: null, lastError: null };
    const machines = loadMachines();
    machines.push(machine);
    saveMachines(machines);
    return { ok: true, machine };
  });

  ipcMain.handle('remote:remove', (_e, id) => {
    const machines = loadMachines().filter((m) => m.id !== id);
    saveMachines(machines);
    return { ok: true, machines };
  });

  // Runs the analysis again. Used for the first analysis and for Reconfigure.
  ipcMain.handle('remote:analyze', async (_e, id) => {
    const machines = loadMachines();
    const machine = machines.find((m) => m.id === id);
    if (!machine) return { ok: false, error: 'That machine is no longer saved.' };
    const result = await remote.runAnalysis(machine);
    if (result.ok) {
      machine.report = result.report;
      machine.analyzedAt = new Date().toISOString();
      machine.lastError = null;
    } else {
      machine.lastError = { message: result.error, at: new Date().toISOString() };
    }
    saveMachines(machines);
    return { ok: result.ok, machine, error: result.ok ? null : result.error };
  });
}

async function createWindow() {
  const server = await startServer();
  const { port } = server.address();
  serverPort = port;

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    resizable: true,
    title: 'Zaude',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#121218',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => server.close());
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

// ---------- AI: text to video ----------
// One render at a time, since the GPU runs one job. Progress goes to the window as "ai:job" events.
const textToVideo = require('./text-to-video.cjs');
const os = require('node:os');

const settingsFile = () => path.join(app.getPath('userData'), 'zaude-settings.json');
const defaultMannimmateDir = () => path.join(os.homedir(), 'Documents', 'MeineProgramme', 'mannimmate');
const defaultOutDir = () => path.join(os.homedir(), 'Videos', 'Zaude');

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    saved = {};
  }
  return {
    mannimmateDir: saved.mannimmateDir || defaultMannimmateDir(),
    python: saved.python || (process.platform === 'win32' ? 'python' : 'python3'),
    outDir: saved.outDir || defaultOutDir(),
    projectFolders: Array.isArray(saved.projectFolders) ? saved.projectFolders : [],
  };
}

function saveSettings(next) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
}

let activeJob = null; // { id, cancel }
const zdSessionDirs = new Set();

// Folders the editor may play media from: the Zaude output folder, Mannimmate's default output,
// opened project folders, and unpacked .zd session folders.
function mediaRoots() {
  const s = loadSettings();
  return [s.outDir, path.join(os.homedir(), 'Videos', 'Mannimmate'), ...projectFolders(), ...zdSessionDirs];
}

function projectFolders() {
  return loadSettings().projectFolders || [];
}

function registerAiHandlers() {
  ipcMain.handle('ai:settings:get', () => loadSettings());

  ipcMain.handle('ai:settings:set', (_e, input) => {
    const current = loadSettings();
    const mannimmateDir = String((input && input.mannimmateDir) || '').trim() || current.mannimmateDir;
    const outDir = String((input && input.outDir) || '').trim() || current.outDir;
    const next = { ...current, mannimmateDir, outDir };
    saveSettings(next);
    return { ok: true, settings: next };
  });

  ipcMain.handle('ai:textToVideo:start', (event, input) => {
    if (activeJob) return { ok: false, error: 'A render is already running. Wait for it or cancel it.' };
    const checked = textToVideo.validateRequest(input);
    if (!checked.ok) return checked;

    const settings = loadSettings();
    const id = crypto.randomUUID();
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:job', { id, ...payload });
    };
    const job = textToVideo.runTextToVideo({
      mannimmateDir: settings.mannimmateDir,
      python: settings.python,
      request: checked.value,
      promptDir: path.join(app.getPath('userData'), 'ai-prompts'),
      outDir: settings.outDir,
      onEvent: send,
    });
    activeJob = { id, cancel: job.cancel };
    job.promise.then((result) => {
      activeJob = null;
      if (result.ok) send({ type: 'done', path: result.path });
      else send({ type: result.cancelled ? 'cancelled' : 'error', message: result.error });
    });
    return { ok: true, id };
  });

  ipcMain.handle('ai:textToVideo:cancel', (_e, id) => {
    if (!activeJob || activeJob.id !== id) return { ok: false, error: 'That render is not running.' };
    activeJob.cancel();
    return { ok: true };
  });

  // Gives the editor a URL it can play. Only files inside the output folders are allowed.
  ipcMain.handle('ai:mediaUrl', (_e, filePath) => {
    if (!media.isAllowedMedia(filePath, mediaRoots())) return { ok: false, error: 'Not a playable file in the output folders.' };
    return { ok: true, url: `http://127.0.0.1:${serverPort}/media/${media.encodeMediaPath(filePath)}` };
  });

  // ---------- project folders ----------
  ipcMain.handle('project:pickFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose a project folder' });
    if (result.canceled || !result.filePaths.length) return null;
    const folder = result.filePaths[0];
    const current = loadSettings();
    if (!current.projectFolders.includes(folder)) {
      saveSettings({ ...current, projectFolders: [...current.projectFolders, folder] });
    }
    return folder;
  });

  ipcMain.handle('project:scan', async (_e, folder) => {
    if (typeof folder !== 'string' || !folder) return { ok: false, error: 'No folder given.' };
    return project.scanFolder(folder);
  });

  ipcMain.handle('project:load', (_e, folder) => {
    if (typeof folder !== 'string' || !folder) return { ok: false, error: 'No folder given.' };
    return project.loadProject(folder);
  });

  ipcMain.handle('project:save', (_e, folder, data) => {
    if (typeof folder !== 'string' || !folder) return { ok: false, error: 'No folder given.' };
    return project.saveProject(folder, data, projectFolders());
  });

  ipcMain.handle('project:waveform', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !media.isAllowedMedia(filePath, mediaRoots())) {
      return { ok: false, error: 'Not an allowed media file.' };
    }
    return waveform.extractWaveform(filePath);
  });

  ipcMain.handle('project:saveZd', async (event, input) => {
    if (!input || typeof input !== 'object') return { ok: false, error: 'Nothing to save.' };
    const win = BrowserWindow.fromWebContents(event.sender);
    let targetPath = typeof input.filePath === 'string' && input.filePath.trim() ? input.filePath.trim() : null;
    if (!targetPath || input.saveAs) {
      const safeName = String(input.name || 'Untitled').replace(/[^A-Za-z0-9 _.-]/g, '_').trim() || 'Untitled';
      const defaultPath = targetPath || path.join(os.homedir(), 'Videos', `${safeName}.zd`);
      const res = await dialog.showSaveDialog(win, {
        title: 'Save Zaude Project (.zd)',
        defaultPath,
        filters: [{ name: 'Zaude Project (*.zd)', extensions: ['zd'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
      targetPath = res.filePath.toLowerCase().endsWith('.zd') ? res.filePath : res.filePath + '.zd';
    }
    return zdFormat.writeZdFile(targetPath, {
      name: input.name || path.basename(targetPath, '.zd'),
      format: input.format,
      resolution: input.resolution,
      clips: input.clips,
      media: input.media,
    });
  });

  ipcMain.handle('project:openZd', async (event, maybePath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    let targetPath = typeof maybePath === 'string' && maybePath.trim() ? maybePath.trim() : null;
    if (!targetPath) {
      const res = await dialog.showOpenDialog(win, {
        title: 'Open Zaude Project (.zd)',
        properties: ['openFile'],
        filters: [{ name: 'Zaude Project (*.zd)', extensions: ['zd'] }],
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
      targetPath = res.filePaths[0];
    }
    const extractRoot = path.join(app.getPath('userData'), 'zd-sessions');
    const opened = await zdFormat.readZdFile(targetPath, extractRoot);
    if (opened.ok && opened.sessionDir) {
      zdSessionDirs.add(opened.sessionDir);
    }
    return opened;
  });

  // ---------- render the timeline to an MP4 (NVIDIA encoder when available) ----------
  // A project's caption file must be a plain file name inside the project folder.
  function captionsPath(folder, name) {
    if (!name || typeof name !== 'string' || /[\\/]/.test(name) || !/\.(ass|srt)$/i.test(name)) return null;
    const p = path.join(folder, name);
    return fs.existsSync(p) ? p : null;
  }

  ipcMain.handle('render:start', async (event, input) => {
    if (!input || !Array.isArray(input.clips)) return { ok: false, error: 'No timeline to render.' };
    const folders = projectFolders();
    const folder = input.folder && folders.includes(input.folder) ? input.folder : loadSettings().outDir;
    fs.mkdirSync(folder, { recursive: true });
    const safeName = String(input.name || 'zaude').replace(/[^A-Za-z0-9 _.-]/g, '_').slice(0, 60) || 'zaude';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ext = String(input.format || 'MP4').toUpperCase() === 'MOV' ? 'mov' : 'mp4';
    const output = path.join(folder, `${safeName}-${stamp}.${ext}`);
    const sender = event.sender;
    renderRunning = true;
    try {
      return await render.renderTimeline({
        clips: input.clips,
        resolution: input.resolution,
        width: input.width,
        height: input.height,
        fps: input.fps,
        quality: input.quality,
        rangeStart: input.rangeStart,
        rangeEnd: input.rangeEnd,
        subtitles: captionsPath(folder, input.captions),
        output,
        onProgress: (p) => { if (!sender.isDestroyed()) sender.send('render:progress', p); },
      });
    } finally {
      renderRunning = false;
    }
  });

  ipcMain.handle('ai:reveal', (_e, filePath) => {
    if (typeof filePath !== 'string' || !fs.existsSync(filePath)) return { ok: false, error: 'File not found.' };
    shell.showItemInFolder(filePath);
    return { ok: true };
  });
}

// ---------- updates ----------
// Checks the newest GitHub release shortly after start and then every 6 hours. Nothing is installed
// without the user's OK: the Update button asks first, downloads the build, then the app restarts on it.
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
let renderRunning = false;
let update = { busy: false, message: '', available: false, latest: null, tag: null, assetName: null, assetUrl: null, checkedAt: null, error: null };

function updateStatus() {
  return {
    ...update,
    current: app.getVersion(),
    canInstall: Boolean(updater.installTarget(process.platform, process.env)),
  };
}

function broadcastUpdate() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('update:status', updateStatus());
  }
}

async function checkForUpdate() {
  if (update.busy) return updateStatus();
  update = { ...update, busy: true, message: 'Checking GitHub…', error: null };
  broadcastUpdate();
  const release = await updater.fetchLatestRelease();
  const checkedAt = new Date().toISOString();
  if (!release.ok) {
    update = { ...update, busy: false, message: '', available: false, error: release.error, checkedAt };
  } else {
    const asset = updater.pickAsset(release.assets, process.platform);
    const newer = updater.isNewer(release.version, app.getVersion());
    const error = newer && !asset ? 'A newer version exists but has no build for this system yet.' : null;
    update = {
      ...update,
      busy: false,
      message: '',
      available: newer && Boolean(asset),
      latest: release.version,
      tag: release.tag,
      assetName: asset ? asset.name : null,
      assetUrl: asset ? asset.url : null,
      error,
      checkedAt,
    };
  }
  broadcastUpdate();
  return updateStatus();
}

async function installUpdate(event) {
  if (update.busy) return { ok: false, error: 'Wait for the current update step to finish.' };
  if (!update.available || !update.tag || !update.assetName || !update.assetUrl) return { ok: false, error: 'No update is ready. Check for updates first.' };
  const target = updater.installTarget(process.platform, process.env);
  if (!target) return { ok: false, error: 'This copy runs from source, so it cannot replace itself. Use git pull instead.' };
  if (activeJob || renderRunning) return { ok: false, error: 'A render is running. Wait for it to finish, then update.' };

  const win = BrowserWindow.fromWebContents(event.sender);
  const choice = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Update and restart', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update Zaude',
    message: `Zaude ${update.latest} is ready.`,
    detail: 'Zaude downloads the new version, closes, replaces itself and starts again. Save your project first (Bin > Save project) if you have changes.',
  });
  if (choice.response !== 0) return { ok: true, cancelled: true };

  update = { ...update, busy: true, message: `Downloading Zaude ${update.latest}…`, error: null };
  broadcastUpdate();
  try {
    const dir = path.join(app.getPath('temp'), 'zaude-update');
    const file = await updater.downloadBuild({
      asset: { name: update.assetName, url: update.assetUrl },
      platform: process.platform,
      dir,
    });
    const logFile = path.join(app.getPath('userData'), 'update.log');
    const args = { pid: process.pid, newFile: file, target, logFile };
    let scriptPath;
    let child;
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32') {
      scriptPath = path.join(dir, 'zaude-update.ps1');
      fs.writeFileSync(scriptPath, updater.windowsScript(args));
      child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      scriptPath = path.join(dir, 'zaude-update.sh');
      fs.writeFileSync(scriptPath, updater.linuxScript(args), { mode: 0o755 });
      child = spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' });
    }
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    child.unref();
    update = { ...update, busy: false, message: 'Restarting…' };
    setTimeout(() => app.quit(), 200);
    return { ok: true };
  } catch (err) {
    update = { ...update, busy: false, message: '', error: err.message || String(err) };
    broadcastUpdate();
    return { ok: false, error: update.error };
  }
}

function registerUpdateHandlers() {
  ipcMain.handle('update:status', () => updateStatus());
  ipcMain.handle('update:check', () => checkForUpdate());
  ipcMain.handle('update:install', (event) => installUpdate(event));
}

registerRemoteHandlers();
registerAiHandlers();
registerUpdateHandlers();
app.whenReady().then(async () => {
  await createWindow();
  setTimeout(() => checkForUpdate(), 15000).unref();
  setInterval(() => checkForUpdate(), UPDATE_EVERY_MS).unref();
});
app.on('window-all-closed', () => app.quit());
