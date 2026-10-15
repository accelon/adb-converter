/**
 * A tiny worker pool with an ordered `submit` API.
 *
 * Tasks are dispatched to idle workers; results resolve out of order, which is
 * exactly what the exporter needs: it reads chunks ahead (bounded window) and
 * consumes them in file order.
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { createDecoder, type DecoderKind } from './bz2';
import { decodeChunk, type ChunkJob, type ChunkResult } from './decode';

export function defaultJobs(): number {
  return Math.max(1, availableParallelism());
}

interface Task {
  id: number;
  job: ChunkJob;
  resolve: (r: ChunkResult) => void;
  reject: (e: Error) => void;
}

export class DecodePool {
  readonly size: number;
  readonly notes: string[];
  /** set when workers were unavailable and we decode on the calling thread */
  readonly inline: boolean;
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private running = new Map<Worker, Task>();
  private queue: Task[] = [];
  private nextId = 1;
  private destroyed = false;
  private inlineDecoder: ReturnType<typeof createDecoder> | null = null;
  private inlineScratch = { buf: new Uint8Array(0) };

  constructor(size = defaultJobs(), kind: DecoderKind = 'auto', forceInline = false) {
    this.size = Math.max(1, size);
    this.notes = [];
    let workerUrl: URL | null = null;
    if (!forceInline) {
      try {
        workerUrl = new URL('./decodeWorker.ts', import.meta.url);
      } catch {
        workerUrl = null;
      }
    }
    if (workerUrl) {
      for (let i = 0; i < this.size; i++) {
        try {
          const w = new Worker(workerUrl.href, { workerData: { kind } });
          w.on('message', (m: any) => this.onMessage(w, m));
          w.on('error', (e) => this.onWorkerError(w, e));
          this.workers.push(w);
          this.idle.push(w);
        } catch (e) {
          this.notes.push(`worker ${i} unavailable: ${(e as Error).message}`);
        }
      }
    }
    this.inline = this.workers.length === 0;
    if (this.inline) {
      if (!forceInline) this.notes.push('no worker threads available, decoding on the main thread (single core)');
      this.inlineDecoder = createDecoder(kind);
      this.notes.push(...this.inlineDecoder.notes);
      this.size = 1;
    }
  }

  get workerCount(): number {
    return this.workers.length;
  }

  private onMessage(w: Worker, m: { id: number; out?: Uint8Array; blocks?: number; error?: string }): void {
    const task = this.running.get(w);
    this.running.delete(w);
    if (task) {
      if (m.error) task.reject(new Error(m.error));
      else task.resolve({ out: m.out!, blocks: m.blocks! });
    }
    if (this.destroyed) return;
    this.idle.push(w);
    this.pump();
  }

  private onWorkerError(w: Worker, e: Error): void {
    const task = this.running.get(w);
    this.running.delete(w);
    if (task) task.reject(e);
    this.workers = this.workers.filter((x) => x !== w);
    this.idle = this.idle.filter((x) => x !== w);
    if (!this.destroyed) this.pump();
  }

  submit(job: ChunkJob): Promise<ChunkResult> {
    if (this.inline) {
      try {
        return Promise.resolve(decodeChunk(this.inlineDecoder!.decoder, job, this.inlineScratch));
      } catch (e) {
        return Promise.reject(e as Error);
      }
    }
    return new Promise<ChunkResult>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, job, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (!this.destroyed && this.queue.length > 0 && this.idle.length > 0) {
      const w = this.idle.pop()!;
      const task = this.queue.shift()!;
      this.running.set(w, task);
      w.postMessage({ id: task.id, job: task.job });
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    for (const task of this.queue) task.reject(new Error('pool destroyed'));
    this.queue.length = 0;
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.idle = [];
    this.inlineDecoder?.decoder.close();
  }
}
