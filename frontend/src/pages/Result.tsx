// 对局结束弹窗（M4 范围）：VICTORY 结算（GAME_OVER）与共识中止（fatal ERROR）两种形态。
import type { GameOverMsg, GameState } from '@dl/shared';
import type { FatalError } from '../stores/game';

interface ResultModalProps {
  gameOver: GameOverMsg | null;
  fatal: FatalError | null;
  board: GameState;
  isSpectator: boolean;
  onClose: () => void;
}

export default function ResultModal({ gameOver, fatal, board, isSpectator, onClose }: ResultModalProps) {
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
            返回大厅
          </button>
        </div>
      </div>
    );
  }
  if (!gameOver) return null;

  const winners = gameOver.winners ?? [];
  const forces = board.forces.filter((f) => f.exists);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[30rem] rounded-xl bg-slate-800 p-6 shadow-2xl">
        <h2 className="text-center text-xl font-bold text-amber-300">
          {winners.length > 0 ? '🎉 对局结束' : '对局结束（平局）'}
        </h2>
        <p className="mt-2 text-center text-sm text-slate-300">
          胜利：<span className="font-medium text-emerald-300">{winners.length > 0 ? winners.join('、') : '无'}</span>
          {gameOver.winningTeam > 0 && <span className="ml-2 text-xs text-slate-500">（队伍 {gameOver.winningTeam}）</span>}
        </p>

        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="py-1">势力</th>
              <th className="py-1">玩家</th>
              <th className="py-1">结果</th>
            </tr>
          </thead>
          <tbody>
            {forces.map((f) => {
              const meta = gameOver.forces.find((x) => x.seat === f.seat);
              const isWinner = f.playerId !== null && winners.includes(String(f.playerId));
              return (
                <tr key={f.seat} className="border-t border-slate-700">
                  <td className="py-1.5">
                    <span className="flex items-center gap-2">
                      <img
                        src={`/static/flags/flag_${f.flag}.png`}
                        alt=""
                        className="h-5 w-4 object-contain"
                        onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                      />
                      {f.name}
                    </span>
                  </td>
                  <td className="py-1.5 text-slate-400">
                    {f.playerId !== null ? (isWinner ? '🏆' : '') + `#${f.playerId}` : f.isAI ? 'AI（休闲）' : '—'}
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
                </tr>
              );
            })}
          </tbody>
        </table>

        <button
          onClick={onClose}
          className="mt-5 w-full rounded bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-500"
        >
          {isSpectator ? '返回大厅' : '返回大厅'}
        </button>
      </div>
    </div>
  );
}
