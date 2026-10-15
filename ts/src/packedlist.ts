/**
 * TPackedList writer, matching lists.pas (Delphi) byte for byte.
 *
 * Layout:  u32 added (bytes of the varint payload)
 *          nMileStone * 8 bytes  (TMileStone = {value: i32; Count: i32})
 *          `added` bytes of varints
 *
 * nMileStone = floor(added / MileDistance) with MileDistance = 512, and the
 * milestones are produced while packing (lists.pas: TPackedList.add):
 *
 *     fdata[added] := MASK_LEADBYTE or (delta and $7F);  inc(added); inc(fcount);
 *     ...
 *     lastAddedValue := offset;
 *     if added div MileDistance > nMileStone then addMileStone;
 *       -> value := lastAddedValue; Count := fcount;
 *
 * so milestone n records the entry and the entry count at the moment the packed
 * payload first grew past n*512 bytes.  The Delphi reader uses them to seek
 * (goMileStone jumps pdata += n*512 and restores curvalue/curcount), which is
 * why a writer that leaves them at zero produces a file that reads sequentially
 * but searches wrongly.
 */
export const MILE_DISTANCE = 512;

/** Number of bytes value `delta` occupies (lists.pas: calbyteneeded). */
export function varintSize(delta: number): number {
  let n = 0;
  do {
    delta = Math.floor(delta / 128);
    n++;
  } while (delta !== 0);
  return n;
}

export interface PackedListInfo {
  buffer: Buffer;
  added: number;
  milestones: number;
}

/** Encode values (ascending, deltas are non negative) exactly like Delphi. */
export function encodePackedList(values: ArrayLike<number>): Buffer {
  return encodePackedListInfo(values).buffer;
}

export function encodePackedListInfo(values: ArrayLike<number>): PackedListInfo {
  const n = values.length;
  // first pass: payload size (needed for the milestone area)
  let added = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    added += varintSize(v - prev);
    prev = v;
  }
  const miles = Math.floor(added / MILE_DISTANCE);
  const buf = Buffer.allocUnsafe(4 + miles * 8 + added);
  buf.writeInt32LE(added, 0);
  let at = 4 + miles * 8;
  let written = 0;
  let milesDone = 0;
  prev = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    let delta = v - prev;
    if (delta < 0) throw new Error(`packed list values must not decrease: ${v} after ${prev}`);
    buf[at++] = delta & 0x7f; // lead byte: high bit clear
    written++;
    delta = Math.floor(delta / 128);
    while (delta > 0) {
      buf[at++] = 0x80 | (delta & 0x7f);
      written++;
      delta = Math.floor(delta / 128);
    }
    prev = v;
    // milestone handling (2005.8.22, no alignment char)
    while (Math.floor(written / MILE_DISTANCE) > milesDone) {
      const off = 4 + milesDone * 8;
      buf.writeInt32LE(v, off); // value
      buf.writeInt32LE(i + 1, off + 4); // Count
      milesDone++;
    }
  }
  if (written !== added || milesDone !== miles) {
    throw new Error(`packed list size mismatch: written=${written} added=${added} miles=${milesDone}/${miles}`);
  }
  return { buffer: buf, added, milestones: miles };
}
