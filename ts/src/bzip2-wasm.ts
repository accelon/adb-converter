
import loadBZip2WASM from './vendor/bzip2-wasm/bzip2.mjs';
import { bzip2WasmBase64 } from './vendor/bzip2-wasm/bzip2-wasm-data';

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let modulePromise: Promise<any> | null = null;

export function bz2Module(): Promise<any> {
  if (!modulePromise) modulePromise = loadBZip2WASM({ wasmBinary: b64ToBytes(bzip2WasmBase64) });
  return modulePromise;
}

export async function bz2Compress(src: Uint8Array, blockSize100k = 9): Promise<Uint8Array> {
  const mod = await bz2Module();
  const srcLen = src.length;
  const cap = Math.max(128, srcLen + Math.ceil(srcLen / 100) + 600);
  const srcPtr = mod._malloc(Math.max(1, srcLen));
  const dstPtr = mod._malloc(cap);
  const lenPtr = mod._malloc(4);
  try {
    mod.setValue(lenPtr, cap, 'i32');
    mod.HEAPU8.set(src, srcPtr);
    const rc = mod._BZ2_bzBuffToBuffCompress(dstPtr, lenPtr, srcPtr, srcLen, blockSize100k, 0, 30);
    if (rc !== 0) throw new Error('bzip2 wasm compress failed rc=' + rc);
    const outLen = mod.getValue(lenPtr, 'i32');
    const out = new Uint8Array(outLen);
    out.set(mod.HEAPU8.subarray(dstPtr, dstPtr + outLen));
    return out;
  } finally {
    mod._free(srcPtr);
    mod._free(dstPtr);
    mod._free(lenPtr);
  }
}

export async function bz2Decompress(src: Uint8Array, rawLen: number): Promise<Uint8Array> {
  const mod = await bz2Module();
  const srcPtr = mod._malloc(Math.max(1, src.length));
  const dstPtr = mod._malloc(rawLen);
  const lenPtr = mod._malloc(4);
  try {
    mod.setValue(lenPtr, rawLen, 'i32');
    mod.HEAPU8.set(src, srcPtr);
    const rc = mod._BZ2_bzBuffToBuffDecompress(dstPtr, lenPtr, srcPtr, src.length, 0, 0);
    if (rc !== 0) throw new Error('bzip2 wasm decompress failed rc=' + rc);
    const outLen = mod.getValue(lenPtr, 'i32');
    const out = new Uint8Array(outLen);
    out.set(mod.HEAPU8.subarray(dstPtr, dstPtr + outLen));
    return out;
  } finally {
    mod._free(srcPtr);
    mod._free(dstPtr);
    mod._free(lenPtr);
  }
}
