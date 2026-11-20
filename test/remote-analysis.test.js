import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import mod from '../electron/remote-analysis.cjs';

const { POSIX_SCRIPT, WINDOWS_SCRIPT, buildSshArgs, validateMachineInput, parseAnalysis } = mod;

test('buildSshArgs uses batch mode, port, key, and runs sh -s on the target', () => {
  const args = buildSshArgs({ target: 'tranklena', port: 2222, keyPath: '~/.ssh/id_ed25519' });
  assert.ok(args.includes('BatchMode=yes'));
  assert.deepEqual(args.slice(-3), ['tranklena', 'sh', '-s']);
  assert.equal(args[args.indexOf('-p') + 1], '2222');
  assert.equal(args[args.indexOf('-i') + 1], '~/.ssh/id_ed25519');
});

test('buildSshArgs omits optional flags when not set', () => {
  const args = buildSshArgs({ target: 'tranklena' });
  assert.ok(!args.includes('-p'));
  assert.ok(!args.includes('-i'));
});

test('validateMachineInput accepts an ssh alias and user@host', () => {
  assert.equal(validateMachineInput({ name: 'tranklena', target: 'tranklena' }).ok, true);
  const r = validateMachineInput({ name: 'Box', target: 'user@192.168.1.20', port: '22' });
  assert.equal(r.ok, true);
  assert.equal(r.value.port, 22);
});

test('validateMachineInput rejects option injection and bad characters', () => {
  assert.equal(validateMachineInput({ name: 'x', target: '-oProxyCommand=evil' }).ok, false);
  assert.equal(validateMachineInput({ name: 'x', target: 'host; rm -rf ~' }).ok, false);
  assert.equal(validateMachineInput({ name: 'x', target: 'host', port: '99999' }).ok, false);
  assert.equal(validateMachineInput({ name: '', target: 'host' }).ok, false);
});

const SAMPLE = `@@os
Linux 6.8.0
@@cpu
AMD Ryzen 9 7950X
32
@@ram
68719476736
@@disk
500000000000
@@gpu
NVIDIA GeForce RTX 4090, 24564
@@comfy
/home/witz/ComfyUI
@@running
yes
@@models
#checkpoints
put_checkpoints_here
juggernautXL.safetensors
#loras
#vae
#controlnet
#upscale_models
#embeddings
#clip
@@end
`;

test('parseAnalysis reads hardware, GPU, ComfyUI, and models', () => {
  const r = parseAnalysis(SAMPLE);
  assert.equal(r.os, 'Linux 6.8.0');
  assert.equal(r.cpu.model, 'AMD Ryzen 9 7950X');
  assert.equal(r.cpu.cores, 32);
  assert.equal(r.ramGB, 64);
  assert.equal(r.gpus[0].name, 'NVIDIA GeForce RTX 4090');
  assert.equal(r.gpus[0].vramGB, 24);
  assert.equal(r.comfyui.present, true);
  assert.equal(r.comfyui.running, true);
  assert.deepEqual(r.models.checkpoints, ['juggernautXL.safetensors']);
  assert.equal(r.comfyui.modelCount, 1);
  assert.ok(r.notes.some((n) => n.includes('SDXL')));
});

test('parseAnalysis handles a machine with no GPU and no ComfyUI', () => {
  const r = parseAnalysis('@@os\nLinux\n@@cpu\nunknown\n4\n@@ram\n0\n@@disk\n0\n@@gpu\n@@comfy\n@@running\nno\n@@models\n@@end\n');
  assert.equal(r.gpus.length, 0);
  assert.equal(r.comfyui.present, false);
  assert.ok(r.notes.some((n) => n.includes('No NVIDIA GPU')));
  assert.ok(r.notes.some((n) => n.includes('ComfyUI was not found')));
});

// Windows has no `sh` with GNU tools (no `free`), and it analyses machines with PowerShell instead.
test('the analysis script runs under sh and its output parses', { skip: process.platform === 'win32' }, () => {
  const out = execFileSync("sh", ["-s"], { input: POSIX_SCRIPT }).toString();
  const r = parseAnalysis(out);
  assert.ok(r.cpu.cores > 0);
  assert.ok(r.ramGB > 0);
});

test('the Windows script is plain text with the same section markers', () => {
  for (const name of ['os', 'cpu', 'ram', 'disk', 'gpu', 'comfy', 'running', 'models', 'end']) {
    assert.ok(WINDOWS_SCRIPT.includes(`'@@${name}'`), `missing @@${name}`);
  }
});
