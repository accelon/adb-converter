/**
 * ROMBlocks container writer (rombuilder.pas / romblock.pas).
 *
 * Layout of one container:
 *
 *   TROMBlocksHeader (16 bytes)
 *     0  feature        u32   boHits/boAscii/boUnicode/boBlocks | boNamed | boSorted | boWithPointer
 *     4  signature      i32   (not used by the reader; preserved as is)
 *     8  totalblocksize u32   bytes of all data blocks (including the name block)
 *     12 blocksize      i32   0 = variable length blocks (packed length list follows the data)
 *   data blocks, concatenated
 *   TPackedList of cumulative end offsets (only when blocksize = 0)
 *   pointer table: count * i32, only when boWithPointer (follows the length list)
 *
 * A named container stores its block names in a nested container that is its
 * last data block; every name is UTF-16LE plus a NUL terminator.
 */
import { encodePackedList } from './packedlist';

export const ROMBLOCK_HEADER_SIZE = 16;
export const BO_WITH_POINTER = 0x40000000;
export const BO_SORTED = 0x20000000;
export const BO_NAMED = 0x10000000;
export const FORMAT_MASK = 0x00000007;
export const BO_UNDEFINED = 0x00000000;
export const BO_HITS = 0x00000001;
export const BO_ASCII = 0x00000002;
export const BO_UNICODE = 0x00000003;
export const BO_BLOCKS = 0x00000004;

export interface ContainerInput {
  feature: number;
  /** data blocks in order; for a named container do NOT include the name block */
  blocks: Buffer[];
  /** block names, written as a nested container in a final data block */
  names?: string[] | null;
  /** feature word of the nested name container (delphi: boUnicode [| boSorted]) */
  nameFeature?: number;
  /** pointer table (boWithPointer), written after the length list */
  pointers?: number[] | null;
  /** feature word of the name container's own pointer table */
  namePointers?: number[] | null;
  signature?: number;
  /** non zero = fixed size blocks (packing pads blocks to this size) */
  blockSize?: number;
}

/** Encode a list of strings the way putStringList does: UTF-16LE + NUL. */
export function stringBlocks(strings: string[]): Buffer[] {
  return strings.map((s) => Buffer.from(s + '\0', 'utf16le'));
}

export function buildContainer(input: ContainerInput): Buffer {
  const blockSize = input.blockSize ?? 0;
  const blocks = [...input.blocks];
  let pointers = input.pointers ?? null;

  if (input.names && input.names.length) {
    const nameFeature = (input.nameFeature ?? BO_UNICODE) | (input.namePointers ? BO_WITH_POINTER : 0);
    const nameBlock = buildContainer({
      feature: nameFeature,
      blocks: stringBlocks(input.names),
      pointers: input.namePointers ?? null,
    });
    blocks.push(nameBlock);
  }

  const sizes = blocks.map((b) => (blockSize ? blockSize : b.length));
  const total = sizes.reduce((a, b) => a + b, 0);

  let header = Buffer.alloc(ROMBLOCK_HEADER_SIZE);
  header.writeUInt32LE(input.feature >>> 0, 0);
  header.writeInt32LE(input.signature ?? 0, 4);
  header.writeUInt32LE(total, 8);
  header.writeInt32LE(blockSize, 12);

  const parts: Buffer[] = [header];
  if (blockSize) {
    for (const b of blocks) {
      if (b.length >= blockSize) parts.push(b.subarray(0, blockSize));
      else {
        const padded = Buffer.alloc(blockSize); // zero padding
        b.copy(padded);
        parts.push(padded);
      }
    }
  } else {
    for (const b of blocks) parts.push(b);
  }

  if (!blockSize) {
    const lengths: number[] = [];
    let acc = 0;
    for (const s of sizes) {
      acc += s;
      lengths.push(acc);
    }
    parts.push(encodePackedList(lengths));
  }

  if (input.feature & BO_WITH_POINTER) {
    const n = pointers ? pointers.length : blocks.length;
    const table = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) table.writeInt32LE(pointers ? pointers[i] : 0, i * 4);
    parts.push(table);
  }

  return Buffer.concat(parts);
}
