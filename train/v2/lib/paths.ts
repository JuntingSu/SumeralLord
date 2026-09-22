// paths.ts — v2 目录布局：产物在 v2/runs/，训练图池/验收图池在 train 根共享
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const v2Root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const trainRoot = path.join(v2Root, '..');

export const V2_ROOT = v2Root;
export const TRAIN_ROOT = trainRoot;
export const MAPS_DIR = path.join(trainRoot, 'maps');
export const EVAL_MAPS_DIR = path.join(trainRoot, 'eval-maps');
export const RUNS_DIR = path.join(v2Root, 'runs');
export const LOGS_DIR = path.join(RUNS_DIR, 'logs');
export const SAMPLES_DIR = path.join(RUNS_DIR, 'samples');
export const WEIGHTS_DIR = path.join(RUNS_DIR, 'weights');
export const STATE_FILE = path.join(RUNS_DIR, 'state.json');
export const CURVE_FILE = path.join(RUNS_DIR, 'curve.csv');
export const DEMOS_DIR = path.join(v2Root, 'demos');
export const PREFS_DIR = path.join(v2Root, 'prefs');
export const DEMO_SAMPLES_DIR = path.join(RUNS_DIR, 'demo-samples');
export const PREF_SAMPLES_DIR = path.join(RUNS_DIR, 'pref-samples');
