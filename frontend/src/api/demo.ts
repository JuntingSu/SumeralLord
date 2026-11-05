import type { DemoReplayFile } from '@dl/shared';
import { api } from './client';

/** POST filename 读取 backend/static/demo/<filename>.json */
export function fetchDemoReplay(filename: string): Promise<DemoReplayFile> {
  return api<DemoReplayFile>('/api/demo/replay', {
    method: 'POST',
    body: JSON.stringify({ filename }),
  });
}
