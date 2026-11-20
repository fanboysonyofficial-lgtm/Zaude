import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import U from '../electron/updater.cjs';

test('parseVersion accepts v-prefixed and plain versions', () => {
  assert.deepEqual(U.parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(U.parseVersion('0.10.0'), [0, 10, 0]);
  assert.equal(U.parseVersion('latest'), null);
  assert.equal(U.parseVersion('1.2'), null);
});

test('isNewer compares numerically, not as text', () => {
  assert.equal(U.isNewer('v0.1.1', '0.1.0'), true);
  assert.equal(U.isNewer('v0.10.0', '0.9.9'), true);
  assert.equal(U.isNewer('v0.1.0', '0.1.0'), false);
  assert.equal(U.isNewer('v0.0.9', '0.1.0'), false);
  assert.equal(U.isNewer('garbage', '0.1.0'), false);
});

test('pickAsset chooses this platform build by suffix', () => {
  const assets = [
    { name: 'Zaude-0.2.0-windows-x64.exe' },
    { name: 'Zaude-0.2.0-linux-x86_64.AppImage' },
    { name: 'notes.txt' },
  ];
  assert.equal(U.pickAsset(assets, 'linux').name, 'Zaude-0.2.0-linux-x86_64.AppImage');
  assert.equal(U.pickAsset(assets, 'win32').name, 'Zaude-0.2.0-windows-x64.exe');
  assert.equal(U.pickAsset(assets, 'darwin'), null);
  assert.equal(U.pickAsset([{ name: 'Zaude-0.2.0-windows-x64.exe' }], 'linux'), null);
});

test('looksLikeBuild checks the file header for each platform', () => {
  assert.equal(U.looksLikeBuild('linux', Buffer.from([0x7f, 0x45, 0x4c, 0x46])), true);
  assert.equal(U.looksLikeBuild('linux', Buffer.from('<htm')), false);
  assert.equal(U.looksLikeBuild('win32', Buffer.from([0x4d, 0x5a, 0x90, 0x00])), true);
  assert.equal(U.looksLikeBuild('win32', Buffer.from([0x7f, 0x45, 0x4c, 0x46])), false);
  assert.equal(U.looksLikeBuild('linux', null), false);
});

test('installTarget uses the AppImage or portable exe path, and nothing when running from source', () => {
  assert.equal(U.installTarget('linux', { APPIMAGE: '/home/a/Zaude.AppImage' }), '/home/a/Zaude.AppImage');
  assert.equal(U.installTarget('linux', {}), null);
  assert.equal(U.installTarget('win32', { PORTABLE_EXECUTABLE_FILE: 'C:\\Apps\\Zaude.exe' }), 'C:\\Apps\\Zaude.exe');
  assert.equal(U.installTarget('win32', {}), null);
});

test('linuxScript waits for the app, swaps the file, and restarts it, with quoted paths', () => {
  const script = U.linuxScript({
    pid: 4321,
    newFile: "/tmp/zaude update/it's.AppImage",
    target: '/home/a/Applications/Zaude.AppImage',
    logFile: '/home/a/log.txt',
  });
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /PID=4321/);
  assert.match(script, /NEW='\/tmp\/zaude update\/it'\\''s\.AppImage'/);
  assert.match(script, /mv -f "\$TARGET\.new" "\$TARGET"/);
  assert.match(script, /"\$TARGET" >\/dev\/null 2>&1 &/);
});

test('windowsScript waits for the process, copies the exe, and restarts it, with PowerShell quoting', () => {
  const text = U.windowsScript({
    pid: 999,
    newFile: "C:\\Temp\\Zaude's.exe",
    target: 'C:\\Users\\me\\Zaude.exe',
    logFile: 'C:\\Users\\me\\update.log',
  });
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.match(text, /\$pidToWait = 999/);
  assert.match(text, /\$new = 'C:\\Temp\\Zaude''s\.exe'/);
  assert.match(text, /Move-Item -LiteralPath \(\$target \+ "\.new"\) -Destination \$target -Force/);
  assert.match(text, /Start-Process -FilePath \$target/);
});

test('generated Linux script has valid shell syntax', { skip: !fs.existsSync('/bin/sh') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-upd-test-'));
  const file = path.join(dir, 'check.sh');
  fs.writeFileSync(file, U.linuxScript({ pid: 1, newFile: '/x/new', target: '/x/Zaude.AppImage', logFile: '/x/log' }));
  execFileSync('/bin/sh', ['-n', file]);
  fs.rmSync(dir, { recursive: true, force: true });
});
