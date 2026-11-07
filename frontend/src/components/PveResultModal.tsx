import { useEffect, useState } from 'react';
import type { GameOverMsg, GameState, MapSource } from '@dl/shared';
import { AI_LEVEL_LABEL } from '@dl/shared';
import { flagImgUrl } from '../lib/flags';
import { getCommunityLike, likeCommunityMap } from '../api/userMaps';

interface PveResultModalProps {
  gameOver: GameOverMsg;
  board: GameState;
  humanUserId: number;
  mapId?: string;
  mapSource?: MapSource;
  onNewGame: () => void;
  onBackRoom: () => void;
  onBackModes: () => void;
}

/** PVE 结算：胜负 + 势力列表；社区地图可点赞 */
export default function PveResultModal({
  gameOver,
  board,
  humanUserId,
  mapId,
  mapSource,
  onNewGame,
  onBackRoom,
  onBackModes,
}: PveResultModalProps) {
  const [likes, setLikes] = useState(0);
  const [liked, setLiked] = useState(false);
  const [liking, setLiking] = useState(false);
  const [likeError, setLikeError] = useState('');
  const likeable = mapSource === 'community' && !!mapId;

  useEffect(() => {
    if (!likeable || !mapId) return;
    let alive = true;
    getCommunityLike(mapId)
      .then((r) => {
        if (!alive) return;
        setLikes(r.likes);
        setLiked(r.liked);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [likeable, mapId]);

  const handleLike = async () => {
    if (!mapId || liked || liking) return;
    setLiking(true);
    setLikeError('');
    try {
      const r = await likeCommunityMap(mapId);
      setLikes(r.likes);
      setLiked(r.liked);
    } catch {
      setLikeError('点赞失败，请稍后再试');
    } finally {
      setLiking(false);
    }
  };
  const winners = gameOver.winners ?? [];
  const humanWon = winners.includes(String(humanUserId));
  const aiWon = (gameOver.winningTeam ?? 0) > 0 && winners.length === 0;
  const draw = gameOver.winningTeam === -1;
  const winningTeam = gameOver.winningTeam;
  const forces = board.forces.filter((f) => f.exists);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl bg-slate-800 p-6 shadow-2xl">
        <h2 className="text-center text-xl font-bold text-amber-300">
          {humanWon ? '🎉 胜利' : aiWon ? '💀 失败' : draw ? '平局' : '对局结束'}
        </h2>
        <p className="mt-2 text-center text-sm text-slate-300">
          {humanWon ? '你击败了所有对手' : aiWon ? 'AI 势力获胜' : draw ? '没有势力取得胜利' : '对局已结束'}
        </p>

        <div className="mt-4 overflow-hidden rounded bg-slate-900/40">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] gap-2 border-b border-slate-700 px-3 py-2 text-xs text-slate-500">
            <span>势力</span>
            <span>扮演</span>
            <span className="text-right">结果</span>
          </div>
          <ul className="max-h-64 overflow-y-auto">
            {forces.map((f) => {
              const meta = gameOver.forces.find((x) => x.seat === f.seat);
              const cleared = !f.alive || Boolean(meta?.cleared);
              const forceWon = winningTeam > 0 && f.team === winningTeam;
              const isHuman = f.playerId !== null && f.playerId === humanUserId;
              const resultText = cleared ? '已清除' : draw ? '平局' : forceWon ? '胜利' : '失败';
              return (
                <li key={f.seat} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] items-center gap-2 border-b border-slate-800 px-3 py-2 text-sm last:border-b-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <img
                      src={flagImgUrl(f.flag)}
                      alt=""
                      className="h-5 w-4 shrink-0 object-contain"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.visibility = 'hidden';
                      }}
                    />
                    <span className="truncate">{f.name}</span>
                  </span>
                  <span className="truncate text-slate-300">
                    {isHuman ? '你' : f.isAI ? `AI·${AI_LEVEL_LABEL[f.computer] ?? '休闲'}` : '—'}
                  </span>
                  <span className={`text-right ${cleared ? 'text-red-400' : forceWon ? 'text-emerald-400' : 'text-slate-400'}`}>
                    {resultText}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        {likeable && (
          <div className="mt-4 flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => void handleLike()}
              disabled={liked || liking}
              className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
                liked
                  ? 'border-rose-500/50 bg-rose-900/30 text-rose-300'
                  : 'border-slate-600 text-slate-300 hover:border-rose-400 hover:text-rose-300'
              } disabled:cursor-default`}
            >
              {liked ? '♥ 已点赞' : liking ? '点赞中…' : '♡ 点赞'} · {likes}
            </button>
            {likeError ? <span className="text-xs text-red-400">{likeError}</span> : null}
          </div>
        )}

        <div className="mt-5 space-y-2">
          <button
            onClick={onNewGame}
            className="w-full rounded bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-500"
          >
            再来一局
          </button>
          <button
            onClick={onBackRoom}
            className="w-full rounded border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-700"
          >
            返回 PVE 房间
          </button>
          <button
            onClick={onBackModes}
            className="w-full rounded px-4 py-2 text-sm text-slate-400 hover:bg-slate-700 hover:text-slate-200"
          >
            返回模式选择
          </button>
        </div>
      </div>
    </div>
  );
}
