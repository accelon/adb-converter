/**
 * `inflateRaw` is hand written (the browser cannot afford one DecompressionStream
 * per zip entry), so it is checked against `node:zlib` on every block type:
 * stored, fixed Huffman (level 1 on short input) and dynamic Huffman (the rest).
 */
import { describe, expect, test } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import { inflateRaw } from '../src/inflate';

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('inflateRaw', () => {
  test('round trips short and long text at every level', () => {
    const samples = [
      '',
      'a',
      'hello, world',
      '子曰：「學而時習之，不亦說乎？」'.repeat(3),
      // a long, repetitive plus a pseudo-random part: exercises dynamic codes
      Array.from({ length: 4000 }, (_, i) => String.fromCharCode(0x4e00 + ((i * 7919) % 500))).join(''),
    ];
    for (const text of samples) {
      const raw = bytes(text);
      for (const level of [0, 1, 6, 9]) {
        const packed = new Uint8Array(deflateRawSync(raw, { level }));
        const out = inflateRaw(packed);
        expect(out.length).toBe(raw.length);
        expect(Buffer.from(out).equals(Buffer.from(raw))).toBe(true);
      }
    }
  });

  test('handles stored blocks larger than 64 KiB', () => {
    const raw = new Uint8Array(200_000);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 31) & 0xff;
    const packed = new Uint8Array(deflateRawSync(raw, { level: 0 }));
    const out = inflateRaw(packed);
    expect(Buffer.from(out).equals(Buffer.from(raw))).toBe(true);
  });

  test('rejects junk', () => {
    expect(() => inflateRaw(new Uint8Array([0xff, 0xff, 0xff]))).toThrow();
  });

  test('matches zlib on the real vault zip when it is present', () => {
    const path = 'D:\\2026\\adb-converter\\《論語句讀新詮》.zip';
    if (!require('node:fs').existsSync(path)) return;   // the vault is not in the repo
    const { scanZip } = require('../src/zip-dir') as typeof import('../src/zip-dir');
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { inflateRawSync } = require('node:zlib') as typeof import('node:zlib');
    const buf = new Uint8Array(readFileSync(path));
    const entries = scanZip(buf).filter((e) => !e.isDir && e.method === 8);
    expect(entries.length).toBeGreaterThan(1000);
    let checked = 0;
    for (const e of entries) {
      const payload = buf.subarray(e.dataStart, e.dataStart + e.compSize);
      const mine = inflateRaw(payload);
      const ref = new Uint8Array(inflateRawSync(payload));
      if (mine.length !== ref.length || !Buffer.from(mine).equals(Buffer.from(ref))) {
        throw new Error(`inflate differs on ${e.name}`);
      }
      checked++;
    }
    expect(checked).toBe(entries.length);
  });
});
