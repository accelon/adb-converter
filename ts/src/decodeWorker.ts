/**
 * Worker thread: owns one bzip2 decoder and decodes chunks on demand.
 *
 * Design note: the compressed bytes are sent to the worker (a copy, but bzip2
 * decode runs at ~30 MB/s while memcpy runs at GB/s, so the copy is noise),
 * the decoded bytes come back as a transferred ArrayBuffer (no copy).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createDecoder, type DecoderKind } from './bz2';
import { decodeChunk, type ChunkJob } from './decode';

const kind = (workerData?.kind ?? 'auto') as DecoderKind;

let decoder: ReturnType<typeof createDecoder> | null = null;
const scratch = { buf: new Uint8Array(0) };

parentPort!.on('message', (msg: { id: number; job: ChunkJob }) => {
  try {
    if (!decoder) decoder = createDecoder(kind);
    const { out, blocks } = decodeChunk(decoder.decoder, msg.job, scratch);
    parentPort!.postMessage({ id: msg.id, out, blocks }, [out.buffer as ArrayBuffer]);
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, error: (e as Error).message ?? String(e) });
  }
});
