import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// root 锚定到 v2/（配置文件所在目录），使 include 与运行目录无关
const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root,
    include: ['tests/**/*.test.ts'],
  },
});
