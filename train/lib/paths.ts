// paths.ts — train 产物目录布局（runs/ 下：权重、样本、日志、曲线、断点状态）
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const trainRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TRAIN_ROOT = trainRoot;
export const MAPS_DIR = path.join(trainRoot, 'maps');
export const EVAL_MAPS_DIR = path.join(trainRoot, 'eval-maps');
export const RUNS_DIR = path.join(trainRoot, 'runs');
export const WEIGHTS_DIR = path.join(RUNS_DIR, 'weights');
export const SAMPLES_DIR = path.join(RUNS_DIR, 'samples');
export const LOGS_DIR = path.join(RUNS_DIR, 'logs');
export const STATE_FILE = path.join(RUNS_DIR, 'state.json');
export const CURVE_FILE = path.join(RUNS_DIR, 'curve.csv');
export const ACCEPTANCE_FILE = path.join(RUNS_DIR, 'acceptance.csv');
