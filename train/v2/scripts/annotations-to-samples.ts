// scripts/annotations-to-samples.ts — 标注转换器（拟合前运行）
// 示范/纠错（v2/demos/*.json）→ runs/demo-samples/（π = 人类动作 one-hot，仅策略项）
// 偏好（v2/prefs/pref-*.json）→ runs/pref-samples/（编码状态 + 视角座次 + label）
// 用法：npx tsx v2/scripts/annotations-to-samples.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { demoToSamples, prefToSample, type DemoFile, type PrefFile } from '../lib/annotations.js';
import { loadLog, getLogIndex } from '../lib/logs.js';
import { DEMO_SAMPLES_DIR, DEMOS_DIR, PREFS_DIR, PREF_SAMPLES_DIR } from '../lib/paths.js';

function loadJson<T>(dir: string, excludePrefixes: string[] = []): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !excludePrefixes.some((p) => f.startsWith(p)))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null);
}

async function main(): Promise<void> {
  getLogIndex(); // 预热索引
  const demos = loadJson<DemoFile>(DEMOS_DIR);
  const prefs = loadJson<PrefFile>(PREFS_DIR, ['pairs-']); // pairs-* 是未判定的题目队列，不当作偏好

  // 示范 → demo-samples
  mkdirSync(DEMO_SAMPLES_DIR, { recursive: true });
  let demoOk = 0;
  let demoSkip = 0;
  for (const demo of demos) {
    const log = loadLog(demo.sourceGameId);
    if (!log) {
      demoSkip++;
      continue;
    }
    const samples = demoToSamples(demo, log);
    if (!samples) {
      demoSkip++;
      console.warn(`[annotations] 跳过 ${demo.id}（重放/意图不一致，sourceGameId=${demo.sourceGameId}）`);
      continue;
    }
    writeFileSync(
      path.join(DEMO_SAMPLES_DIR, `${demo.id}.jsonl`),
      samples.map((s) => JSON.stringify(s)).join('\n') + '\n',
    );
    demoOk++;
  }
  console.log(`[annotations] 示范/纠错：${demos.length} 条 → 有效 ${demoOk} / 跳过 ${demoSkip}`);

  // 偏好 → pref-samples
  mkdirSync(PREF_SAMPLES_DIR, { recursive: true });
  const logs = new Map<string, ReturnType<typeof loadLog>>();
  for (const pref of prefs) {
    const need = pref.kind === 'position' ? [pref.a.sourceGameId, pref.b.sourceGameId] : [pref.sourceGameId];
    for (const gid of need) {
      if (!logs.has(gid)) logs.set(gid, loadLog(gid));
    }
    const sample = prefToSample(pref, logs as Map<string, NonNullable<ReturnType<typeof loadLog>>>);
    if (!sample) {
      console.warn(`[annotations] 跳过偏好 ${pref.id}（日志缺失/重放失败）`);
      continue;
    }
    writeFileSync(path.join(PREF_SAMPLES_DIR, `${pref.id}.jsonl`), JSON.stringify(sample) + '\n');
  }
  console.log(`[annotations] 偏好：${prefs.length} 条（unknown 已过滤），有效写入 ${PREF_SAMPLES_DIR}`);
  console.log(`[annotations] 完成：demo-samples=${DEMO_SAMPLES_DIR} pref-samples=${PREF_SAMPLES_DIR}`);
}

main().catch((e) => {
  console.error('[annotations] 失败：', e);
  process.exit(1);
});
