import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '127.0.0.1',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-do-not-use-in-prod',
  isProd: process.env.NODE_ENV === 'production',
  dbPath: process.env.DL_DB_PATH ?? path.join(__dirname, '../data/digital_lord.db'),
  /** 对局流锁定版本：与前端 reducer 构建版本对齐（BM6 做握手强校验） */
  reducerVersion: process.env.REDUCER_VERSION ?? 'dev-0.1.0',
};

if (config.isProd && config.jwtSecret === 'dev-secret-do-not-use-in-prod') {
  throw new Error('生产环境必须设置 JWT_SECRET');
}
