#!/usr/bin/env bun
/**
 * 抽出每個作品正文開頭的 `No. X [cf. No. Y]`，寫成 build/jingqun/cf.tsv。
 * 這是 CBETA 自己给的「註疏 → 本經」交叉引用，優先於任何字面比對。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dir;
const ROOT = resolve(HERE, '..');
const T = process.env.TAISHO_TEI ?? 'D:\\2023\\sat2018\\T';
const rows: string[] = ['root\tno\tcf\tfirst'];
for (const vd of readdirSync(T).sort()) {
  if (!/^T\d\d$/.test(vd)) continue;
  const dir = join(T, vd);
  const seen = new Set<string>();
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.xml')) continue;
    const root = f.replace(/_\d+\.xml$/, '');
    if (seen.has(root)) continue;
    seen.add(root);
    const text = readFileSync(join(dir, f), 'utf8');
    const at = text.indexOf('<body>');
    const body = text.slice(at, at + 12000);
    const plain = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const m = /^No\.\s*(\d+[a-z]?)\s*(?:\[cf\.\s*No\.\s*([0-9]+[a-z]?)\])?/i.exec(plain);
    rows.push([root, m?.[1] ?? '', m?.[2] ?? '', plain.slice(0, 80).replace(/\t/g, ' ')].join('\t'));
  }
}
writeFileSync(join(ROOT, 'build/jingqun/cf.tsv'), rows.join('\n') + '\n');
console.log(`works=${rows.length - 1}`);
