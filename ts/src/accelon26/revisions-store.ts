/** 匯入的 revisions 先留在記憶體（WeakMap 跟著目前 reader），下次 rebuild 會一起寫進 revisions container。 */
import type { AdbReader } from './adb';
import { readRevisions, type RevisionInfo } from './rebuild-browser';

const extra = new WeakMap<AdbReader, RevisionInfo[]>();

export async function allRevisions(reader: AdbReader): Promise<RevisionInfo[]> {
  const base = await readRevisions(reader);
  const more = extra.get(reader) ?? [];
  const seen = new Set(base.map((r) => r.id));
  return [...base, ...more.filter((r) => !seen.has(r.id))];
}

export function extraRevisions(reader: AdbReader): RevisionInfo[] {
  return (extra.get(reader) ?? []).slice();
}

export function addRevisions(reader: AdbReader, revs: RevisionInfo[]): number {
  const list = extra.get(reader) ?? [];
  const seen = new Set(list.map((r) => r.id));
  let added = 0;
  for (const r of revs) {
    if (seen.has(r.id)) continue;
    list.push(r);
    seen.add(r.id);
    added++;
  }
  extra.set(reader, list);
  return added;
}
