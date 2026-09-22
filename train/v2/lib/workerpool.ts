// workerpool.ts — worker 子进程批处理池（train-v2 主循环与验收脚本共用）
// 每个 worker 领取一个任务、完成后领取下一个；队列空则退出。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerJob, WorkerResult } from '../scripts/worker.js';
import { V2_ROOT } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 批量派发任务到 worker 池；返回与 jobs 同序的结果数组（按 jobId 对齐） */
export async function runWorkerJobs(jobs: WorkerJob[], workerCount: number): Promise<WorkerResult[]> {
  const resultsByJob = new Map<number, WorkerResult>();
  let next = 0;
  const count = Math.min(workerCount, jobs.length);
  if (count === 0) return [];
  await Promise.all(
    Array.from({ length: count }, () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--max-old-space-size=1024', '--import', 'tsx', path.join(__dirname, '..', 'scripts', 'worker.ts')],
          { cwd: V2_ROOT, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' },
        );
        let done = false;
        const assign = () => {
          const job = jobs[next++];
          if (job) child.send(job);
          else if (!done) {
            done = true;
            child.kill();
          }
        };
        child.on('message', (msg: WorkerResult) => {
          resultsByJob.set(msg.jobId, msg);
          assign();
        });
        child.on('exit', (code) => {
          if (done) resolve();
          else {
            done = true;
            if (code === 0) resolve();
            else reject(new Error(`worker 异常退出（code=${code}）`));
          }
        });
        child.on('error', reject);
        assign();
      }),
    ),
  );
  return jobs.map((j) => resultsByJob.get(j.jobId)!);
}
