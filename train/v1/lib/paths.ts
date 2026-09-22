// paths.ts — v1 产物目录布局（runs/ 下：权重、样本、日志、曲线、断点状态）
// v1 已归档至 train/v1：产物目录随 v1 走（v1/runs），训练图池/验收图池仍在 train 根共享。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const v1Root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const trainRoot = path.join(v1Root, '..');

export const TRAIN_ROOT = trainRoot;
export const V1_ROOT = v1Root;
export const MAPS_DIR = path.join(trainRoot, 'maps');
export const EVAL_MAPS_DIR = path.join(trainRoot, 'eval-maps');
export const DEMOS_DIR = path.join(v1Root, 'demos');
export const RUNS_DIR = path.join(v1Root, 'runs');
export const WEIGHTS_DIR = path.join(RUNS_DIR, 'weights');
export const SAMPLES_DIR = path.join(RUNS_DIR, 'samples');
export const LOGS_DIR = path.join(RUNS_DIR, 'logs');
export const STATE_FILE = path.join(RUNS_DIR, 'state.json');
export const CURVE_FILE = path.join(RUNS_DIR, 'curve.csv');
export const ACCEPTANCE_FILE = path.join(RUNS_DIR, 'acceptance.csv');
