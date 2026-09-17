// AiBotManager 生命周期单元测试（注入 fake spawn，不真起进程）：
// spawn 条件/参数、崩溃退避重拉、restartMax 放弃、kill 清理、dispose 全杀
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { BotSessionService } from '../src/ws/botSession.js';
import { AiBotManager } from '../src/ai-bot/manager.js';
import type { Game } from '../src/game/manager.js';
import type { MapFullData } from '@dl/shared';

/** 可控的假子进程（实现 ChildProcess 的测试面） */
class MockProc extends EventEmitter {
  exitCode: number | null = null;
  killedSignal: string | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(signal?: string): void {
    this.killedSignal = signal ?? 'SIGTERM';
  }
  emitExit(code: number): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

interface SpawnCall {
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
  proc: MockProc;
}

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'gtest1',
    roomId: 'r1',
    reducerVersion: 'dev-0.1.0',
    seed: 'abc',
    spawnAssignments: [],
    seatAssignments: [
      { seat: 1, playerId: 101, isAI: false },
      { seat: 2, playerId: null, isAI: true, computer: 255 },
    ],
    map: {} as MapFullData,
    timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
    status: 'in_game',
    clearedSeats: new Set(),
    participants: new Map(),
    dismissedPlayerIds: new Set(),
    eventIdCounter: 0,
    createdAt: Date.now(),
    logFile: path.join(tmpdir(), 'x.jsonl'),
    ...overrides,
  };
}

describe('AiBotManager 生命周期', () => {
  let dir: string;
  let sessions: BotSessionService;
  let calls: SpawnCall[];
  let output: string[];

  function makeManager(opts: Partial<ConstructorParameters<typeof AiBotManager>[1]> = {}): AiBotManager {
    calls = [];
    output = [];
    sessions = new BotSessionService(60_000);
    return new AiBotManager(sessions, {
      bootDir: path.join(dir, 'boot'),
      restartBackoffMs: 10,
      restartMax: 2,
      onOutput: (_g, line) => output.push(line),
      spawnFn: ((cmd: string, args: string[], spawnOpts: { env?: Record<string, string | undefined> }) => {
        const proc = new MockProc();
        calls.push({ cmd, args, env: spawnOpts.env ?? {}, proc });
        return proc as unknown as ChildProcess;
      }) as never,
      ...opts,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dl-bot-mgr-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('无 AI 席位不 spawn；有 AI 席位 spawn：node + tsx cli + 入口，env 带 AI_BOT_BOOT，boot 文件内容完整', () => {
    const mgr = makeManager();
    mgr.spawn(makeGame({ seatAssignments: [{ seat: 1, playerId: 101, isAI: false }] }));
    expect(calls).toHaveLength(0);

    const game = makeGame();
    mgr.spawn(game);
    expect(mgr.size).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([expect.stringContaining('tsx'), expect.stringContaining('bot.ts')]);
    expect(calls[0].cmd).toBe(process.execPath);
    const bootPath = calls[0].env.AI_BOT_BOOT!;
    expect(existsSync(bootPath)).toBe(true);
    const boot = JSON.parse(readFileSync(bootPath, 'utf8'));
    expect(boot).toMatchObject({ gameId: 'gtest1', roomId: 'r1', logFile: game.logFile });
    expect(boot.wsUrl).toContain('/ws-bot?token=');
    expect(boot.wsUrl).toContain('gameId=gtest1');
    expect(boot.wsUrl).toContain('reducerVersion=dev-0.1.0');
    expect(boot.wsUrl).toContain('ws://127.0.0.1:4096'); // 默认 config.port；可传 wsPort
    mgr.dispose();
  });

  it('崩溃（非主动 kill）→ 指数退避重拉；超 restartMax 放弃并清理 boot 文件', async () => {
    const mgr = makeManager();
    mgr.spawn(makeGame());
    expect(calls).toHaveLength(1);

    // 第一次崩溃 → 10ms 后重拉
    calls[0].proc.emitExit(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toHaveLength(2);

    // 第二次崩溃 → 20ms 后重拉（restarts=1 → backoff 10*2）
    calls[1].proc.emitExit(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toHaveLength(3);

    // 第三次崩溃（restarts=2 = restartMax）→ 放弃：无重拉、记录清除、boot 清理
    calls[2].proc.emitExit(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toHaveLength(3);
    expect(mgr.size).toBe(0);
    expect(existsSync(path.join(dir, 'boot', 'gtest1.json'))).toBe(false);
    expect(output.join('\n')).toContain('重启次数超限');
  });

  it('kill：SIGTERM + boot 清理；kill 后的退出不触发重拉', async () => {
    const mgr = makeManager();
    mgr.spawn(makeGame());
    const bootPath = path.join(dir, 'boot', 'gtest1.json');
    expect(existsSync(bootPath)).toBe(true);

    mgr.kill('gtest1');
    expect(calls[0].proc.killedSignal).toBe('SIGTERM');
    expect(mgr.size).toBe(0);
    expect(existsSync(bootPath)).toBe(false);

    // 进程随后退出：不应重拉
    calls[0].proc.emitExit(0);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toHaveLength(1);
  });

  it('对局已结束（非 in_game）时崩溃不重拉；spawn 幂等（重复调用只拉一次）', async () => {
    const mgr = makeManager();
    const game = makeGame({ status: 'aborted' });
    mgr.spawn(game);
    expect(calls).toHaveLength(1);
    calls[0].proc.emitExit(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toHaveLength(1); // 对局已中止：不重拉
    expect(mgr.size).toBe(0);

    // spawn 幂等：同 game 再 spawn 不重复（记录已清，视为新对局——此处验证 has 分支）
    const game2 = makeGame();
    mgr.spawn(game2);
    mgr.spawn(game2);
    expect(calls).toHaveLength(2);
    mgr.dispose();
  });

  it('dispose：全部 kill（服务器关闭清理）', async () => {
    const mgr = makeManager();
    mgr.spawn(makeGame({ id: 'g1' }));
    mgr.spawn(makeGame({ id: 'g2' }));
    expect(mgr.size).toBe(2);
    mgr.dispose();
    expect(mgr.size).toBe(0);
    expect(calls.every((c) => c.proc.killedSignal === 'SIGTERM')).toBe(true);
  });

  it('enabled=false 时不 spawn', () => {
    const mgr = makeManager({ enabled: false });
    mgr.spawn(makeGame());
    expect(calls).toHaveLength(0);
    expect(mgr.size).toBe(0);
  });
});
