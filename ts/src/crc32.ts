/**
 * CRC-32 as used by the database header (crc32.pas):
 *
 *   CRC_MAGIC = $55AA55AA is the initial value, and the loop is the standard
 *   reflected CRC-32 (table driven, polynomial $EDB88320):
 *
 *     crc := (crc shr 8) xor Table[byte xor (crc and $FF)]
 *
 *   index.pas writes it over the first sizeof(header)-4 bytes, so the stored
 *   value covers everything except the crc32 field itself.
 */
export const CRC_MAGIC = 0x55aa55aa;

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array, init = CRC_MAGIC): number {
  let crc = init >>> 0;
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc >>> 8) ^ TABLE[(buf[i] ^ crc) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}
