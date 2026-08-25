// 对局内聊天（POV 改动）：默认折叠在棋盘区域右下角仅显示最近一条消息，
// 点击小三角展开查看全部对话；输入栏单行、发送按钮紧凑；观战也可发言。
import { useEffect, useRef, useState } from 'react';
import type { ChatEntry } from '../stores/room';

interface GameChatProps {
  chat: ChatEntry[];
  /** 发送（返回 false 表示发送失败，提示并保留输入） */
  onSend: (text: string) => boolean;
}

export default function GameChat({ chat, onSend }: GameChatProps) {
  const [expanded, setExpanded] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const chatListRef = useRef<HTMLDivElement>(null);

  // 新消息自动滚底
  useEffect(() => {
    const el = chatListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length]);

  const last = chat[chat.length - 1];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text) return;
    if (!onSend(text)) {
      setSendError('连接已断开，消息未发送');
      return;
    }
    setSendError(null);
    setChatInput('');
  };

  return (
    <div className="absolute bottom-12 right-3 z-10 flex flex-col items-end gap-1.5">
      {expanded ? (
        <div className="w-72 rounded-lg bg-slate-800/95 shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-700 px-3 py-1.5">
            <span className="text-xs font-bold text-slate-300">对话</span>
            <button
              onClick={() => setExpanded(false)}
              className="rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-slate-700"
              aria-label="收起对话"
            >
              <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M2 7.5l4-4 4 4" />
              </svg>
            </button>
          </div>
          <div ref={chatListRef} className="max-h-48 space-y-1 overflow-y-auto px-3 py-2 text-xs">
            {chat.length === 0 && <p className="text-slate-500">暂无消息</p>}
            {chat.map((m) => (
              <p key={`${m.ts}-${m.from}`}>
                <span className="text-emerald-400">{m.username}：</span>
                <span className="text-slate-200">{m.text}</span>
              </p>
            ))}
          </div>
          {/* 单行输入 + 小发送 */}
          <form onSubmit={handleSubmit} className="flex items-center gap-1.5 border-t border-slate-700 px-2 py-1.5">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              maxLength={200}
              placeholder="输入消息…"
              className="min-w-0 flex-1 rounded bg-slate-700 px-2 py-1 text-xs text-white outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <button
              type="submit"
              className="shrink-0 rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500"
            >
              发送
            </button>
          </form>
          {sendError && <p className="px-3 pb-1 text-right text-[10px] text-red-400">{sendError}</p>}
        </div>
      ) : (
        /* 折叠：仅显示最近一条 + 右下角小三角展开 */
        <button
          onClick={() => setExpanded(true)}
          className="flex max-w-72 items-center gap-1.5 rounded-lg bg-slate-800/90 px-3 py-1.5 text-left text-xs shadow-lg hover:bg-slate-700"
          title="展开全部对话"
        >
          <span className="truncate">
            {last ? (
              <>
                <span className="text-emerald-400">{last.username}：</span>
                <span className="text-slate-200">{last.text}</span>
              </>
            ) : (
              <span className="text-slate-500">暂无消息</span>
            )}
          </span>
          <span className="shrink-0 text-slate-400">
            <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M2 4.5l4 4 4-4" />
            </svg>
          </span>
        </button>
      )}
    </div>
  );
}
