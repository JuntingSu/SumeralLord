// roundresume.ts — 断点续跑：扫描一轮自对弈的完成情况
// worker 按 jobId 确定性命名样本/日志（sampleio 统一加 game- 前缀 → game-j<gi>.bin）：
// 文件存在且可完整解析 = 该局已完成，重启时跳过不重跑。
// 旧格式（随机 gameId 命名的 game-<random>.bin，无 jobId 信息）样本内容与 gi 无关，
// 可按文件序映射到空位 gi 一并跳过（见 assignLegacyGi）；映射不了的空位余量保留不删。
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { countSamplesBinary } from './sampleio.js';

export interface RoundResume {
  /** gi → 样本数（game-j<gi>.bin 完整存在，重启时可跳过不重跑） */
  completed: Map<number, number>;
  /** 旧格式（game-<random>.bin）完成局的样本数列表（文件名排序；内容与 gi 无关） */
  legacyCounts: number[];
}

/** 扫描一轮自对弈完成情况；目录不存在（全新轮次）返回全空 */
export function scanRoundResume(samplesDir: string): RoundResume {
  const completed = new Map<number, number>();
  const legacyCounts: number[] = [];
  if (!existsSync(samplesDir)) return { completed, legacyCounts };
  const bins = readdirSync(samplesDir)
    .filter((f) => f.endsWith('.bin'))
    .sort();
  for (const f of bins) {
    const cnt = countSamplesBinary(path.join(samplesDir, f));
    if (cnt === null) continue; // 损坏/截断：视为未完成，重启时重跑覆盖
    const m = /^game-j(\d+)\.bin$/.exec(f);
    if (m) completed.set(Number(m[1]), cnt);
    else legacyCounts.push(cnt);
  }
  return { completed, legacyCounts };
}

/**
 * 旧格式样本按文件序映射到 [startGi, endGi) 内最小编号空位（样本内容与 gi 无关，映射仅用于跳过重跑）。
 * 映射成功者并入 completed；未映射者留在 legacyCounts。返回剩余旧局数（空位不足时 >0）。
 */
export function assignLegacyGi(resume: RoundResume, startGi: number, endGi: number): number {
  const taken = new Set(resume.completed.keys());
  const remaining: number[] = [];
  for (const cnt of resume.legacyCounts) {
    let gi = startGi;
    while (gi < endGi && taken.has(gi)) gi++;
    if (gi >= endGi) {
      remaining.push(cnt);
      continue;
    }
    taken.add(gi);
    resume.completed.set(gi, cnt);
  }
  resume.legacyCounts = remaining;
  return remaining.length;
}
