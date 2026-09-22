// scripts/sample-questions.ts — 偏好题抽样器（每轮拟合前运行一次）
// 局面题：同图两局同视角回合末局面配对（近回合优先、去重）；
// 走法题：决策点跑当前模型 MCTS，A = 访问数第一、B = 第二。
// 产物：v2/prefs/pairs-<ts>.json（判题工作台消费；判定后写 pref-<ts>.json 进入训练）。
// 用法：npx tsx v2/scripts/sample-questions.ts [--model <onnx>] [--num-position N] [--num-action N] [--sims N]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { NeuralNet } from '../lib/nn.js';
import { PREFS_DIR, WEIGHTS_DIR } from '../lib/paths.js';
import { loadAllLogs, sampleActionQuestions, samplePositionQuestions } from '../lib/sampler.js';

function get(key: string): string | undefined {
  const i = process.argv.indexOf(`--${key}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const numPosition = Number(get('num-position') ?? '20');
  const numAction = Number(get('num-action') ?? '20');
  const sims = Number(get('sims') ?? '100');
  const modelPath =
    get('model') ?? (existsSync(path.join(WEIGHTS_DIR, 'pool.json'))
      ? (() => {
          const pool = JSON.parse(readFileSync(path.join(WEIGHTS_DIR, 'pool.json'), 'utf8')) as { current?: string };
          return path.join(WEIGHTS_DIR, `model-${pool.current ?? 'v0'}.onnx`);
        })()
      : path.join(WEIGHTS_DIR, 'model-v0.onnx'));

  const logs = loadAllLogs();
  console.log(`[sample-questions] 日志 ${logs.length} 局，局面题 ${numPosition} / 走法题 ${numAction}（sims=${sims}）`);

  const questions = samplePositionQuestions(logs, {
    numPositionQuestions: numPosition,
    numActionQuestions: numAction,
  });
  let actionQuestions: typeof questions = [];
  if (numAction > 0) {
    const net = await NeuralNet.load(modelPath);
    actionQuestions = await sampleActionQuestions(logs, net, {
      numPositionQuestions: 0,
      numActionQuestions: numAction,
      actionSims: sims,
    });
  }

  const all = [...questions, ...actionQuestions];
  mkdirSync(PREFS_DIR, { recursive: true });
  const out = path.join(PREFS_DIR, `pairs-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify({ id: path.basename(out, '.json'), createdAt: new Date().toISOString(), questions: all }, null, 2));
  console.log(`[sample-questions] 生成 ${all.length} 题（局面 ${questions.length} / 走法 ${actionQuestions.length}）：${out}`);
}

main().catch((e) => {
  console.error('[sample-questions] 失败：', e);
  process.exit(1);
});
