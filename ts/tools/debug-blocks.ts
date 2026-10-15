import { openSync, closeSync, statSync } from 'node:fs';
import { parseBlockSet, parseHeader, readAt, BO_NAMED } from '../src/format';

const fd = openSync(process.argv[2], 'r');
console.log('size', statSync(process.argv[2]).size);
console.log('header', parseHeader(readAt(fd, 0, 256)));
const outer = parseBlockSet(fd, 256);
console.log('outer', { ...outer, lengths: outer.lengths });
if (outer.lengths) {
  const nbs = outer.dataStart + outer.lengths[outer.lengths.length - 2];
  console.log('nameBlockStart', nbs, 'feature', outer.feature, 'named?', !!(outer.feature & BO_NAMED));
  console.log('name block bytes', readAt(fd, nbs, 64).toString('hex'));
  const nb = parseBlockSet(fd, nbs);
  console.log('names sub', { ...nb, lengths: nb.lengths });
}
closeSync(fd);
