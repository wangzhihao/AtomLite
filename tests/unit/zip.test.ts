import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildZip, crc32 } from '../../src/lib/shared/zip.ts';

test('crc32 matches the reference value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip round-trips through the system unzip (including UTF-8 names)', (t) => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    t.skip('unzip not available');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const files = { 'App.jsx': 'const a = "你好";\n', 'data/posts.json': '[1,2,3]', '说明.txt': 'hello' };
  writeFileSync(join(dir, 'a.zip'), buildZip(files));
  execFileSync('unzip', ['-q', join(dir, 'a.zip'), '-d', join(dir, 'out')]);
  for (const [p, c] of Object.entries(files)) assert.equal(readFileSync(join(dir, 'out', p), 'utf8'), c);
});
