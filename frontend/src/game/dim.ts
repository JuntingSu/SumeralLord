// 与棋盘渲染一致的「兵力变灰」判定，以及前端自动跳过阶段的判定。
// 变灰集合原来内联在 BoardCanvas；抽出后供 UI 渲染与自动跳过共用，避免两处规则漂移。
import { isFullBreak, isNeutralOwner, neighborsOf } from '@dl/shared';
import type { GameState } from '@dl/shared';

/**
 * 兵力数字变灰判定（除下列条件外一律白色）：
 *  1 加点阶段的断兵
 *  2 行动阶段、我方无行动力的兵
 *  3 行动阶段、敌方（非我方阵营）反击次数为 0 的兵
 *  4 行动阶段、我方兵周围六格全为全断地形或同队兵（无路可走；仅限我方）
 *  5 我方 1 兵力连兵（连兵强度 1 无法进攻；仅限我方）
 * board 每次变化（覆盖发起进攻/移动/生成/失去行动力/切阶段/结束回合/兵消失/回合开始）
 * 都整体重算一次集合，绘制时只查表；复杂度 O(地块数×6)，不影响帧率。
 */
export function computeDimTiles(board: GameState, viewerSeat: number | null): Set<number> {
  const set = new Set<number>();
  const { phase, tiles, forces } = board;
  const teamOf = (seat: number) => forces.find((f) => f.seat === seat)?.team;
  // 阵营判定：中立兵按 owner 相等，势力兵按队伍
  const sameSide = (a: number, b: number) => {
    if (isNeutralOwner(a) || isNeutralOwner(b)) return a === b;
    const ta = teamOf(a);
    return ta !== undefined && ta === teamOf(b);
  };
  const mySide = (owner: number) => viewerSeat !== null && sameSide(owner, viewerSeat);
  const geo = { rows: board.rows, columns: board.columns, cylindrical: board.cylindrical };
  for (let i = 0; i < tiles.length; i++) {
    const s = tiles[i].soldier;
    if (!s) continue;
    if (phase === 'ADD_POINT' && !s.isLinked) {
      set.add(i); // 1
      continue;
    }
    // 5：1 兵力连兵（仅我方；敌方 1 力连兵仍按白色渲染）
    if (viewerSeat !== null && mySide(s.owner) && s.isLinked && s.strength === 1) {
      set.add(i);
      continue;
    }
    if (phase !== 'ACTION') continue;
    if (viewerSeat !== null && mySide(s.owner) && !s.hasMovement) {
      set.add(i); // 2
      continue;
    }
    if (viewerSeat !== null && !mySide(s.owner) && s.counter === 0) {
      set.add(i); // 3
      continue;
    }
    // 4：周围六格全为全断地形/同队兵（仅我方；敌方被围仍按白色渲染）
    if (viewerSeat === null || !mySide(s.owner)) continue;
    let trapped = true;
    for (const n of neighborsOf(i, geo)) {
      const t = tiles[n];
      if (isFullBreak(t.terrain)) continue;
      if (t.soldier && sameSide(t.soldier.owner, s.owner)) continue;
      trapped = false;
      break;
    }
    if (trapped) set.add(i);
  }
  return set;
}

/**
 * 前端自动跳过阶段判定（当前轮到 seat 时）：
 * - 行动阶段：当前阵营（我方，按队伍判定，与渲染变灰的「我方」一致）所有兵都被渲染为灰色
 *   （含无行动力 / 1 力连兵 / 四周全断地形或同队兵而无路可走）
 * - 加点阶段：点数已耗尽（终于耗尽最后一点）
 * 只在当前行动席位是自己时返回 true；AI 席位的行动阶段由 AI 计划自行切换，不在此列。
 */
export function shouldAutoSkipPhase(board: GameState, seat: number): boolean {
  if (board.finished || board.currentSeat !== seat) return false;
  const force = board.forces.find((f) => f.seat === seat);
  if (!force || !force.exists || !force.alive) return false;
  if (board.phase === 'ACTION') {
    const dim = computeDimTiles(board, seat);
    const mySide = (owner: number): boolean => {
      if (isNeutralOwner(owner)) return false;
      const f = board.forces.find((x) => x.seat === owner);
      return f !== undefined && f.team === force.team;
    };
    for (let i = 0; i < board.tiles.length; i++) {
      const s = board.tiles[i].soldier;
      if (s && mySide(s.owner) && !dim.has(i)) return false;
    }
    return true;
  }
  if (board.phase === 'ADD_POINT') return force.points === 0;
  return false;
}
