// 对局结束弹窗（M4 范围）：VICTORY 结算（GAME_OVER）与共识中止（fatal ERROR）两种形态。
// M5.4：结算后可跳转历史回放。
// POV：玩家列展示用户名（替代 id），并附全员积分变动（GET /api/game/:gameId/result）。
import { Link } from 'react-router-dom';
import type { GameOverMsg, GameResultData, GameState } from '@dl/shared';
import type { FatalError } from '../stores/game';
import { flagImgUrl } from '../lib/flags';

interface ResultModalProps {
  gameOver: GameOverMsg | null;
  fatal: FatalError | null;
  board: GameState;
  isSpectator: boolean;
  /** 对局 id（回放入口，M5.4） */
  gameId: string | null;
  /** 结算结果（玩家名 + 全员积分变动；未返回时为 null） */
  result: GameResultData | null;
  /** 用户名兜底（房间玩家；结算结果未返回时避免闪现 id） */
  playerNames: Map<number, string>;
  onClose: () => void;
}

export default function ResultModal({
  gameOver,
  fatal,
  board,
  gameId,
  result,
  playerNames,
  onClose,
}: ResultModalProps) {
  if (fatal) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="w-96 rounded-xl bg-slate-800 p-6 text-center shadow-2xl">
          <h2 className="text-xl font-bold text-red-400">对局中止</h2>
          <p className="mt-3 text-sm text-slate-300">{fatal.message}</p>
          <p className="mt-2 text-xs text-slate-500">本局不结算，房间可重新开始</p>
          <button
            onClick={onClose}
            className="mt-5 rounded bg-slate-600 px-5 py-2 text-sm font-medium text-white hover:bg-slate-500"
          >
            返回房间
          </button>
        </div>
      </div>
    );
  }
  if (!gameOver) return null;

  const winners = gameOver.winners ?? [];
  const forces = board.forces.filter((f) => f.exists);
  const participantBySeat = new Map((result?.participants ?? []).map((p) => [p.seat, p]));
  const changeByPlayerId = new Map((result?.scoreChanges ?? []).map((c) => [c.playerId, c]));
  // 玩家名解析：结算结果（权威）→ 房间玩家（兜底）→ 未知
  const playerNameOf = (seat: number, playerId: number | null): string | null => {
    if (playerId === null) return null;
    return participantBySeat.get(seat)?.username ?? playerNames.get(playerId) ?? null;
  };
  // 胜者玩家名映射（forces 提供 seat↔playerId；未知时兜底 #id）
  const nameByPlayerId = new Map<number, string>();
  for (const f of forces) {
    if (f.playerId === null) continue;
    nameByPlayerId.set(f.playerId, playerNameOf(f.seat, f.playerId) ?? `#${f.playerId}`);
  }
  const winnerNames = winners.map((id) => nameByPlayerId.get(Number(id)) ?? id);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[32rem] rounded-xl bg-slate-800 p-6 shadow-2xl">
        <h2 className="text-center text-xl font-bold text-amber-300">
          {winners.length > 0 ? '🎉 对局结束' : '对局结束（平局）'}
        </h2>
        <p className="mt-2 text-center text-sm text-slate-300">
          胜利：<span className="font-medium text-emerald-300">{winnerNames.length > 0 ? winnerNames.join('、') : '无'}</span>
          {gameOver.winningTeam > 0 && <span className="ml-2 text-xs text-slate-500">（队伍 {gameOver.winningTeam}）</span>}
        </p>

        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="py-1">势力</th>
              <th className="py-1">玩家</th>
              <th className="py-1">结果</th>
              <th className="py-1">积分</th>
            </tr>
          </thead>
          <tbody>
            {forces.map((f) => {
              const meta = gameOver.forces.find((x) => x.seat === f.seat);
              const isWinner = f.playerId !== null && winners.includes(String(f.playerId));
              const name = playerNameOf(f.seat, f.playerId);
              const change = f.playerId !== null ? changeByPlayerId.get(f.playerId) : undefined;
              return (
                <tr key={f.seat} className="border-t border-slate-700">
                  <td className="py-1.5">
                    <span className="flex items-center gap-2">
                      <img
                        src={flagImgUrl(f.flag)}
                        alt=""
                        className="h-5 w-4 object-contain"
                        onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                      />
                      {f.name}
                    </span>
                  </td>
                  <td className="py-1.5 text-slate-300">
                    {f.playerId !== null
                      ? (isWinner ? '🏆 ' : '') + (name ?? `#${f.playerId}`)
                      : f.isAI
                        ? 'AI（休闲）'
                        : '—'}
                  </td>
                  <td className="py-1.5">
                    {!f.alive || meta?.cleared ? (
                      <span className="text-red-400">已清除</span>
                    ) : isWinner ? (
                      <span className="text-emerald-400">胜利</span>
                    ) : (
                      <span className="text-slate-400">失败</span>
                    )}
                  </td>
                  <td className="py-1.5">
                    {change ? (
                      <span className={change.delta > 0 ? 'text-emerald-400' : change.delta < 0 ? 'text-red-400' : 'text-slate-400'}>
                        {change.delta > 0 ? '+' : ''}
                        {change.delta.toFixed(1)}
                      </span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <button
          onClick={onClose}
          className="mt-5 w-full rounded bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-500"
        >
          返回房间
        </button>
        {gameId && (
          <Link
            to={`/replay/${gameId}`}
            className="mt-2 block w-full rounded border border-slate-600 px-4 py-2 text-center text-sm text-slate-300 hover:bg-slate-700"
          >
            查看回放
          </Link>
        )}
      </div>
    </div>
  );
}
