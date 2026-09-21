import { readFileSync } from 'node:fs';
const lines = readFileSync('runs/logs/game-004499.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const start = lines.find((o) => o.type === 'GAME_START');
const bf = start.map.battlefield;
const names = ['平原', '据点', '王城', '海洋', '山地', '虚空'];
for (const t of [3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 31, 32, 33, 34, 45, 46, 47, 60, 61, 74]) {
  const [terr, owner, str] = bf[t];
  console.log(`#${t} (r${Math.floor(t / 14)},c${t % 14}) 地形=${names[terr] ?? terr} owner=${owner} 兵力=${str}`);
}
