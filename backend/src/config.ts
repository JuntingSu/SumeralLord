import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME } from '@dl/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));

export const config = {
  port: Number(process.env.PORT ?? 4096),
  host: process.env.HOST ?? '127.0.0.1',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-do-not-use-in-prod',
  isProd: process.env.NODE_ENV === 'production',
  dbPath: process.env.DL_DB_PATH ?? path.join(__dirname, '../data/digital_lord.db'),
  /** 对局流锁定版本：与前端 reducer 构建版本对齐（BM6 做握手强校验） */
  reducerVersion: process.env.REDUCER_VERSION ?? 'dev-0.1.0',
  /** 断线治理时间线（BM6：全部可配置，测试用加速值） */
  disconnectDetectMs: num(process.env.DL_DISCONNECT_DETECT_MS, GAME.DISCONNECT_DETECT_MS),
  disconnectGraceMs: num(process.env.DL_DISCONNECT_GRACE_MS, GAME.DISCONNECT_GRACE_MS),
  consensusTimeoutMs: num(process.env.DL_CONSENSUS_TIMEOUT_MS, GAME.CONSENSUS_TIMEOUT_MS),
  /** 对局硬上限（IN_GAME 超时解散，reason=game_timeout） */
  gameHardCapMs: num(process.env.DL_GAME_HARD_CAP_MS, GAME.GAME_HARD_CAP_MS),
  /** GAME_OVER 结算展示保留时长，超时回落 ROOM_OPEN */
  gameOverRetainMs: num(process.env.DL_GAME_OVER_RETAIN_MS, 5 * 60 * 1000),
  /** 地图目录元数据刷新间隔（完整地图按需读盘，仅小字段周期重扫） */
  mapsReloadMs: num(process.env.DL_MAPS_RELOAD_MS, 5000),
  /** AI 服务端托管：每局含 AI 席位的对局拉起 ai-bot 子进程（测试可关） */
  aiBotEnabled: process.env.AI_BOT_ENABLED !== '0',
  /** bot 崩溃重启退避（首次等待毫秒数，每次翻倍） */
  aiBotRestartBackoffMs: num(process.env.AI_BOT_RESTART_BACKOFF_MS, 1000),
  /** bot 崩溃重启次数上限（超出后放弃，等待对局结束） */
  aiBotRestartMax: num(process.env.AI_BOT_RESTART_MAX, 8),
};

if (config.isProd && config.jwtSecret === 'dev-secret-do-not-use-in-prod') {
  throw new Error('生产环境必须设置 JWT_SECRET');
}
