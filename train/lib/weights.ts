// weights.ts — E_te 权重版本管理（种子权重表 / JSON 读写 / 版本追溯，设计方案 §6）
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { SEED_TE_WEIGHTS, type TeWeights } from './eval.js';

export interface WeightRecord {
  version: number;
  weights: TeWeights;
  /** 拟合时的已完成对局数 */
  gamesDone: number;
  createdAt: string;
  note?: string;
}

export function cloneWeights(w: TeWeights): TeWeights {
  return { mid: [...w.mid], late: [...w.late] };
}

export function weightsEqual(a: TeWeights, b: TeWeights): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class WeightStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** 读当前权重（无任何版本文件时返回种子权重 v0，并落盘） */
  current(): WeightRecord {
    const latest = this.latest();
    if (latest) return latest;
    const record: WeightRecord = {
      version: 0,
      weights: cloneWeights(SEED_TE_WEIGHTS),
      gamesDone: 0,
      createdAt: new Date().toISOString(),
      note: 'seed',
    };
    this.save(record);
    return record;
  }

  latest(): WeightRecord | null {
    const files = readdirSync(this.dir)
      .filter((f) => /^v(\d+)\.json$/.test(f))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    if (files.length === 0) return null;
    return JSON.parse(readFileSync(path.join(this.dir, files[0]), 'utf8')) as WeightRecord;
  }

  save(record: WeightRecord): void {
    writeFileSync(path.join(this.dir, `v${record.version}.json`), JSON.stringify(record, null, 2));
  }

  /** 保存新版本（版本号 = 当前最新 + 1） */
  next(weights: TeWeights, gamesDone: number, note?: string): WeightRecord {
    const latest = this.latest();
    const record: WeightRecord = {
      version: (latest?.version ?? -1) + 1,
      weights: cloneWeights(weights),
      gamesDone,
      createdAt: new Date().toISOString(),
      note,
    };
    this.save(record);
    return record;
  }
}

/** 训练状态（断点续训） */
export interface TrainState {
  gamesDone: number;
  weightVersion: number;
  /** 已完成对局的样本文件序号（样本按 100 局批次聚合落盘） */
  sampleBatch: number;
  updatedAt: string;
}

export function loadTrainState(file: string): TrainState | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as TrainState;
}

export function saveTrainState(file: string, state: TrainState): void {
  writeFileSync(file, JSON.stringify(state, null, 2));
}
