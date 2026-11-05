import { readFileSync, writeFileSync } from "node:fs";
const page = process.argv[2];
const DATA = "D:\\2026\\agent-norms\\lossless-simplified\\simplified-data.ts";
const SAFE = [...readFileSync(DATA,"utf8").match(/export const SAFE_PAIRS\s*=\s*((?:"[^"]*"\s*\+?\s*)+)/)![1].matchAll(/"([^"]*)"/g)].map(m=>m[1]).join("");
let html = readFileSync(page, "utf8");
const body = html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ");
const chars = new Set(body);
const zhuOk = chars.has("著") && !/著(?:作|名|者|述|錄)|土著/.test(body);
const FIX: Record<string,string> = { 線: "线" };
const pairs: string[] = [];
for (let i=0;i<SAFE.length;i+=2){ const t=SAFE[i], s=FIX[t]??SAFE[i+1]; if(!chars.has(t)) continue; if(t==="著"&&!zhuOk) continue; pairs.push(t+s); }
const table = pairs.join("");
html = html.replace(/var P = "[^"]*"/, 'var P = "' + table + '"');
writeFileSync(page, html);
console.log("pairs", pairs.length);
