import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME } from '@dl/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));

export const config = {
  port: Number(process.env.PORT ?? 3000),
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
};

if (config.isProd && config.jwtSecret === 'dev-secret-do-not-use-in-prod') {
  throw new Error('生产环境必须设置 JWT_SECRET');
}
