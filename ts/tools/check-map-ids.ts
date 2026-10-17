/**
 * Keep accelon26-map.html honest.
 *
 * Every id named in the schematic must exist in the built viewer, and every id the
 * viewer uses must be named in the schematic — otherwise the schematic stops being
 * usable as the shared vocabulary.
 *
 *   bun run tools/check-map-ids.ts [--html ../../build/accelon26.html] [--map ../../accelon26-map.html]
 *
 * Exits 1 when the two sets differ, so the map cannot silently rot.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const HTML = resolve(import.meta.dir, opt('html', '../../build/accelon26.html'));
const MAP = resolve(import.meta.dir, opt('map', '../../accelon26-map.html'));

const html = readFileSync(HTML, 'utf8');
// the schematic's CSS has hex colours (#b00020) that look like ids, so drop it
const map = readFileSync(MAP, 'utf8').replace(/<style>[\s\S]*?<\/style>/g, '');

const markupIds = (s: string): Set<string> =>
  new Set([...s.matchAll(/\sid="([A-Za-z][\w-]*)"/g)].map((m) => m[1]));
const idRefs = (s: string): Set<string> =>
  new Set([...s.matchAll(/#([A-Za-z][\w-]*)/g)].map((m) => m[1]));

const built = markupIds(html);
const named = idRefs(map);
/** used as a selector prefix in the map, not a name of its own */
const prefixes = new Set(['L', 'Ln', 'paneLeft', 'paneRight']);

const missing = [...named].filter((x) => !built.has(x) && !prefixes.has(x)).sort();
const unmentioned = [...built].filter((x) => !named.has(x)).sort();

console.log('viewer ids ' + built.size + ' | named in map ' + named.size);
if (missing.length) console.log('named in map but NOT in viewer: ' + missing.join(' '));
if (unmentioned.length) console.log('in viewer but NOT in map: ' + unmentioned.join(' '));
if (missing.length || unmentioned.length) { console.log('FAIL'); process.exit(1); }
console.log('OK: id sets match');
