import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFileName, sniffType } from '../../src/lib/shared/attachments.ts';

const bytes = (...xs: number[]) => new Uint8Array(xs);
const enc = (s: string) => new TextEncoder().encode(s);

test('recognises images and PDFs by magic bytes, not by name', () => {
  assert.deepEqual(sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), 'a.txt'), { type: 'image/png', kind: 'image' });
  assert.deepEqual(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0), 'photo.png'), { type: 'image/jpeg', kind: 'image' });
  assert.deepEqual(sniffType(enc('GIF89a...'), 'x'), { type: 'image/gif', kind: 'image' });
  assert.deepEqual(sniffType(enc('RIFF\0\0\0\0WEBPVP8 '), 'x.webp'), { type: 'image/webp', kind: 'image' });
  assert.deepEqual(sniffType(enc('%PDF-1.7\n'), 'doc.bin'), { type: 'application/pdf', kind: 'pdf' });
});

test('accepts UTF-8 text only with a text extension; rejects SVG, binaries and unknown types', () => {
  assert.deepEqual(sniffType(enc('名字,金额\n午饭,25'), 'bill.csv'), { type: 'text/csv', kind: 'text' });
  assert.deepEqual(sniffType(enc('{"a":1}'), 'data.json'), { type: 'application/json', kind: 'text' });
  assert.equal(sniffType(enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.svg'), null);
  assert.equal(sniffType(enc('<svg/>'), 'x.svg.txt'.replace('.txt', '')), null);
  assert.equal(sniffType(enc('plain'), 'notes'), null);
  assert.equal(sniffType(bytes(0x48, 0x00, 0x49), 'bin.txt'), null);
  assert.equal(sniffType(bytes(0xc3, 0x28), 'bad.txt'), null);
  assert.equal(sniffType(enc('MZ\x90\x00'), 'app.exe'), null);
});

test('cleans file names', () => {
  assert.equal(cleanFileName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(cleanFileName('  '), 'file');
});
