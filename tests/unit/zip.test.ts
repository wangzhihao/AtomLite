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

test('zip round-trips through Python zipfile (CRC check, UTF-8 names)', (t) => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
  } catch {
    t.skip('python3 not available');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const files = { 'App.jsx': 'const a = "你好";\n', 'data/posts.json': '[1,2,3]', '说明.txt': 'hello' };
  writeFileSync(join(dir, 'a.zip'), buildZip(files));
  const script = 'import json,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps({n: z.read(n).decode("utf-8") for n in z.namelist()}))';
  const out = JSON.parse(execFileSync('python3', ['-I', '-c', script, join(dir, 'a.zip')], { encoding: 'utf8' }));
  assert.deepEqual(out, files);
  assert.ok(readFileSync(join(dir, 'a.zip')).subarray(0, 2).toString() === 'PK');
});
