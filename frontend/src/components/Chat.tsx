// 通用聊天栏（M5.3）：房间页与对局页复用。列表 + 输入 + 发送；
// disabled 时输入灰禁（对局中观战不可发，后端方案 §5 决策 9）。
import { useEffect, useRef, useState } from 'react';
import type { ChatEntry } from '../stores/room';

interface ChatProps {
  chat: ChatEntry[];
  /** 观战/离线等不可发言场景 */
  disabled?: boolean;
  placeholder?: string;
  /** 发送（返回 false 表示发送失败，提示并保留输入） */
  onSend: (text: string) => boolean;
}

export default function Chat({ chat, disabled = false, placeholder = '输入消息…', onSend }: ChatProps) {
  const [chatInput, setChatInput] = useState('');
  const chatListRef = useRef<HTMLDivElement>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  // 新消息自动滚底
  useEffect(() => {
    const el = chatListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
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
    <div className="mx-auto flex max-w-6xl gap-3">
      <div
        ref={chatListRef}
        className={`h-24 flex-1 space-y-1 overflow-y-auto rounded bg-slate-800 px-3 py-2 text-sm ${
          disabled ? 'opacity-60' : ''
        }`}
      >
        {chat.length === 0 && <p className="text-slate-500">暂无消息</p>}
        {chat.map((m) => (
          <p key={`${m.ts}-${m.from}`}>
            <span className="text-emerald-400">{m.username}：</span>
            <span className="text-slate-200">{m.text}</span>
          </p>
        ))}
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          maxLength={200}
          disabled={disabled}
          placeholder={disabled ? '观战中，无法影响对局' : placeholder}
          className="w-64 rounded bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled}
          className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          发送
        </button>
      </form>
      {sendError && <span className="self-center text-xs text-red-400">{sendError}</span>}
    </div>
  );
}
