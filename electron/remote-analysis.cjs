// Remote machine support: builds ssh commands, runs the hardware/ComfyUI analysis, and parses the result.
// Pure functions live here so they can be tested without Electron.
const { spawn } = require('node:child_process');

const ANALYSIS_TIMEOUT_MS = 90 * 1000;
const CALL_TIMEOUT_MS = 60 * 1000;
const MODEL_FOLDERS = ['checkpoints', 'diffusion_models', 'unet', 'loras', 'vae', 'text_encoders', 'clip', 'clip_vision', 'controlnet', 'upscale_models', 'embeddings'];
const MAX_MODELS_PER_FOLDER = 200;
// ComfyUI ships placeholder files such as put_checkpoints_here. They are not models.
const PLACEHOLDER_RE = /^put_.*_here$/;

// Linux and macOS remotes. Runs through `sh -s`, with the script sent on stdin.
// Each section starts with a line "@@name". Missing tools give empty sections instead of errors.
const POSIX_SCRIPT = [
  'echo "@@os"',
  'uname -sr 2>/dev/null',
  'echo "@@cpu"',
  'CPU_MODEL=$(lscpu 2>/dev/null | sed -n \'s/^Model name: *//p\' | head -1)',
  '[ -z "$CPU_MODEL" ] && CPU_MODEL=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)',
  'echo "${CPU_MODEL:-unknown}"',
  'nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0',
  'echo "@@ram"',
  'RAM=$(free -b 2>/dev/null | awk \'/^Mem:/{print $2}\')',
  '[ -z "$RAM" ] && RAM=$(sysctl -n hw.memsize 2>/dev/null)',
  'echo "${RAM:-0}"',
  'echo "@@disk"',
  'df -Pk "$HOME" 2>/dev/null | awk \'NR==2{print $4*1024}\'',
  'echo "@@gpu"',
  'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null',
  'echo "@@comfy"',
  'COMFY=""',
  'for d in "$HOME/ComfyUI" "$HOME/comfyui" "$HOME/Comfy/ComfyUI" "$HOME/ComfyUI-master" /opt/ComfyUI /workspace/ComfyUI; do',
  '  if [ -f "$d/main.py" ]; then COMFY="$d"; break; fi',
  'done',
  'if [ -z "$COMFY" ]; then',
  '  P=$(ps -eo args 2>/dev/null | sed -n \'s#.*\\(/[^ ]*main\\.py\\).*#\\1#p\' | head -1)',
  '  if [ -n "$P" ] && [ -f "$P" ]; then COMFY=$(dirname "$P"); fi',
  'fi',
  'if [ -z "$COMFY" ]; then for p in $(pgrep -f main.py 2>/dev/null); do d=$(readlink /proc/$p/cwd 2>/dev/null); if [ -n "$d" ] && [ -f "$d/main.py" ]; then COMFY="$d"; break; fi; done; fi',
  'echo "$COMFY"',
  'echo "@@running"',
  'if curl -s -m 3 http://127.0.0.1:8188/system_stats >/dev/null 2>&1; then echo yes; else echo no; fi',
  'echo "@@models"',
  'if [ -n "$COMFY" ]; then',
  `  for sub in ${MODEL_FOLDERS.join(' ')}; do`,
  '    echo "#$sub"',
  '    ls -1 "$COMFY/models/$sub" 2>/dev/null',
  '  done',
  'fi',
  'echo "@@end"',
  '',
].join('\n');

// Windows remotes (for example a PC set up with the OpenSSH server, whose default shell is PowerShell).
// Sent to "powershell -Command -" on stdin.
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Write-Output '@@os'",
  '$os = Get-CimInstance Win32_OperatingSystem',
  "Write-Output ('Windows ' + $os.Caption + ' ' + $os.Version)",
  "Write-Output '@@cpu'",
  '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1',
  "if ($cpu) { Write-Output $cpu.Name.Trim() } else { Write-Output 'unknown' }",
  '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum',
  "Write-Output '@@ram'",
  '(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory',
  "Write-Output '@@disk'",
  "(Get-CimInstance Win32_LogicalDisk -Filter (\"DeviceID='\" + $env:SystemDrive + \"'\")).FreeSpace",
  "Write-Output '@@gpu'",
  '& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null',
  "Write-Output '@@comfy'",
  "$comfy = ''",
  '$candidates = @("$env:USERPROFILE\\ComfyUI", "$env:USERPROFILE\\ComfyUI_windows_portable\\ComfyUI", "$env:USERPROFILE\\Desktop\\ComfyUI_windows_portable\\ComfyUI", "$env:USERPROFILE\\Downloads\\ComfyUI_windows_portable\\ComfyUI", "C:\\ComfyUI", "C:\\ComfyUI_windows_portable\\ComfyUI")',
  'foreach ($d in $candidates) { if (Test-Path (Join-Path $d "main.py")) { $comfy = $d; break } }',
  // Not in the usual folders: look for a running python process that started ComfyUI's main.py.
  "if (-not $comfy) { foreach ($p in (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'main\\.py' })) { $dir = Split-Path $p.ExecutablePath -Parent; for ($i = 0; $i -lt 4 -and $dir; $i++) { if (Test-Path (Join-Path $dir 'main.py')) { $comfy = $dir; break }; $dir = Split-Path $dir -Parent }; if ($comfy) { break } } }",
  'Write-Output $comfy',
  "Write-Output '@@running'",
  "try { Invoke-WebRequest -Uri 'http://127.0.0.1:8188/system_stats' -TimeoutSec 3 -UseBasicParsing | Out-Null; Write-Output 'yes' } catch { Write-Output 'no' }",
  "Write-Output '@@models'",
  'if ($comfy) {',
  `  foreach ($sub in @(${MODEL_FOLDERS.map((f) => `'${f}'`).join(', ')})) {`,
  "    Write-Output ('#' + $sub)",
  "    Get-ChildItem -Path (Join-Path $comfy (Join-Path 'models' $sub)) -Name | ForEach-Object { Write-Output $_ }",
  '  }',
  '}',
  "Write-Output '@@end'",
  '',
].join('; ');

// Sent first to tell Windows from POSIX. On Linux the "powershell" command does not exist, so nothing comes back.
const WINDOWS_PROBE = 'Write-Output ZAUDE_WINDOWS';
const POSIX_REMOTE = ['sh', '-s'];
const WINDOWS_REMOTE = ['powershell', '-NoProfile', '-NonInteractive', '-Command', '-'];

// Arguments for ssh, without a shell, so host names can't inject commands.
// BatchMode means ssh never waits for a password prompt; keys and ~/.ssh/config are used as usual.
function buildSshArgs(machine, remoteCommand = POSIX_REMOTE) {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (machine.port) args.push('-p', String(machine.port));
  if (machine.keyPath) args.push('-i', machine.keyPath, '-o', 'IdentitiesOnly=yes');
  args.push(machine.target, ...remoteCommand);
  return args;
}

const TARGET_RE = /^[A-Za-z0-9._@:\[\]-]+$/;

// Checks user input for a new machine. Returns { ok, value } or { ok: false, error }.
function validateMachineInput(input) {
  const name = String((input && input.name) || '').trim();
  const target = String((input && input.target) || '').trim();
  const portRaw = String((input && input.port) || '').trim();
  const keyPath = String((input && input.keyPath) || '').trim();
  if (!name || name.length > 60) return { ok: false, error: 'Give the machine a name (up to 60 characters).' };
  if (!target || target.startsWith('-') || !TARGET_RE.test(target)) {
    return { ok: false, error: 'Enter an ssh host, such as tranklena or user@192.168.1.20.' };
  }
  let port = null;
  if (portRaw) {
    port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Port must be a number from 1 to 65535.' };
  }
  if (keyPath && keyPath.startsWith('-')) return { ok: false, error: 'Key file path looks wrong.' };
  return { ok: true, value: { name, target, port, keyPath: keyPath || null } };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Turns the script output into a report object.
function parseAnalysis(text) {
  const sections = {};
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('@@')) {
      current = line.slice(2).trim();
      sections[current] = [];
      continue;
    }
    if (current && line !== '') sections[current].push(line);
  }
  const first = (key) => (sections[key] || [])[0] || '';

  const gpus = (sections.gpu || [])
    .map((line) => {
      const parts = line.split(',');
      const mem = Number(parts.pop().trim());
      return { name: parts.join(',').trim(), vramGB: Number.isFinite(mem) ? round1(mem / 1024) : 0 };
    })
    .filter((g) => g.name);

  const models = {};
  let folder = null;
  for (const line of sections.models || []) {
    if (line.startsWith('#')) {
      folder = line.slice(1);
      models[folder] = [];
    } else if (folder && models[folder].length < MAX_MODELS_PER_FOLDER && !PLACEHOLDER_RE.test(line) && !line.startsWith('.')) {
      models[folder].push(line);
    }
  }
  const modelCount = Object.values(models).reduce((sum, list) => sum + list.length, 0);

  const ramGB = round1((Number(first('ram')) || 0) / 1024 ** 3);
  const diskFreeGB = round1((Number(first('disk')) || 0) / 1024 ** 3);
  const cpuLines = sections.cpu || [];
  const comfyPath = first('comfy');
  const running = first('running') === 'yes';

  const notes = [];
  const topVram = Math.max(0, ...gpus.map((g) => g.vramGB));
  if (gpus.length === 0) notes.push('No NVIDIA GPU found. Image generation would run on the CPU and be very slow.');
  else if (topVram >= 12) notes.push('GPU has enough VRAM for SDXL-class models.');
  else if (topVram >= 8) notes.push('GPU suits SD 1.5 and SDXL with smaller batches.');
  else notes.push('GPU has limited VRAM. Stick to SD 1.5 class models.');
  if (ramGB && ramGB < 16) notes.push('Less than 16 GB RAM. Large models may need swap.');
  if (!comfyPath) notes.push('ComfyUI was not found in the usual folders.');
  else if (modelCount === 0) notes.push('ComfyUI is installed but no models were found.');

  return {
    os: first('os'),
    cpu: { model: cpuLines[0] || 'unknown', cores: Number(cpuLines[1]) || 0 },
    ramGB,
    diskFreeGB,
    gpus,
    comfyui: { present: Boolean(comfyPath), path: comfyPath || null, running, modelCount },
    models,
    notes,
  };
}

// Removes ssh's own warning lines (such as the post-quantum notice) so the error shown is the real one.
function cleanError(stderr, code) {
  const lines = String(stderr)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('**') && !l.startsWith('Warning: Permanently added'));
  if (lines.length) return lines.slice(-3).join(' ');
  return code === null ? 'Timed out.' : 'ssh exited with code ' + code + '.';
}

// Runs one ssh call with an optional stdin script. Resolves to { code, stdout, stderr }.
function sshCall(machine, remoteCommand, stdin, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ssh', buildSshArgs(machine, remoteCommand), { windowsHide: true });
    } catch (e) {
      return resolve({ code: 255, stdout: '', stderr: 'Could not start ssh: ' + e.message });
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 255, stdout, stderr: 'Could not start ssh: ' + e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {}); // ssh may exit before reading stdin, e.g. on a connection error
    child.stdin.end(stdin);
  });
}

// Runs the analysis over ssh. Resolves to { ok, report } or { ok: false, error }.
async function runAnalysis(machine) {
  // A connection problem shows up as ssh exit code 255, so stop early and report it.
  const probe = await sshCall(machine, WINDOWS_REMOTE, WINDOWS_PROBE, CALL_TIMEOUT_MS);
  if (probe.code === 255 || probe.code === null) {
    return { ok: false, error: cleanError(probe.stderr, probe.code) };
  }
  const isWindows = probe.stdout.includes('ZAUDE_WINDOWS');

  const run = isWindows
    ? await sshCall(machine, WINDOWS_REMOTE, WINDOWS_SCRIPT, ANALYSIS_TIMEOUT_MS)
    : await sshCall(machine, POSIX_REMOTE, POSIX_SCRIPT, ANALYSIS_TIMEOUT_MS);
  if (run.code !== 0 && run.code !== null) {
    return { ok: false, error: cleanError(run.stderr, run.code) };
  }
  if (run.code === null) return { ok: false, error: 'Timed out after 90 seconds.' };
  return { ok: true, report: parseAnalysis(run.stdout) };
}

module.exports = {
  POSIX_SCRIPT,
  WINDOWS_SCRIPT,
  WINDOWS_PROBE,
  buildSshArgs,
  validateMachineInput,
  parseAnalysis,
  runAnalysis,
};
