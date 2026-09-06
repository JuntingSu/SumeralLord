// 个性皮肤工坊（移植自「V5 数字领主地块皮肤生成器.html」）：
// 上传图片 → 六边形框选（缩放/平移/滚轮/双指）→ 确认裁剪 → 生成两张与本地旗帜同规格的
// 192×216 PNG（solid + hollow，尖顶六边形 R=100 居中，hollow 挖外圈 16px 环）→ 确认上传到服务器。
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type WheelEvent, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { uploadSkin } from '../api/users';
import { ApiError } from '../api/client';
import { useAuth } from '../stores/auth';

// 输出画布与六边形规格（与 backend/static/flags/*.png 一致：192×216、尖顶、外接圆 R=100、居中）
const OUTPUT_W = 192;
const OUTPUT_H = 216;
const OUT_HEX_R = 100;
/** hollow 挖空环宽（与 backend/scripts/gen-flags.mjs 的 HOLLOW_RING=16 一致） */
const HOLLOW_RING = 16;

/** 尖顶正六边形路径（不调用 beginPath，调用方管理路径生命周期） */
function hexPath(c: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.closePath();
}

function drawCheckerboard(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const s = 12;
  c.fillStyle = '#1a1d24';
  c.fillRect(x, y, w, h);
  c.fillStyle = '#232733';
  for (let r = 0; r < Math.ceil(h / s); r++) {
    for (let col = 0; col < Math.ceil(w / s); col++) {
      if ((r + col) % 2 === 0) c.fillRect(x + col * s, y + r * s, s, s);
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

/**
 * 断兵镂空版：对 solid 画布做像素级环形镂空（六边形外圈 HOLLOW_RING px 变透明），
 * 与 backend/scripts/gen-flags.mjs 的 hollow 判定一致。逐像素处理可避免
 * destination-out 在部分浏览器中与 drawImage 叠加时的合成异常。
 */
function punchHollowRing(source: HTMLCanvasElement): HTMLCanvasElement {
  const SQRT3 = Math.sqrt(3);
  const out = document.createElement('canvas');
  out.width = OUTPUT_W;
  out.height = OUTPUT_H;
  const ctx = out.getContext('2d');
  if (!ctx) return out;
  ctx.drawImage(source, 0, 0);
  const imageData = ctx.getImageData(0, 0, OUTPUT_W, OUTPUT_H);
  const d = imageData.data;
  const CX = OUTPUT_W / 2;
  const CY = OUTPUT_H / 2;
  const W2 = (SQRT3 / 2) * OUT_HEX_R;
  for (let y = 0; y < OUTPUT_H; y++) {
    for (let x = 0; x < OUTPUT_W; x++) {
      const dx = Math.abs(x - CX);
      const dy = Math.abs(y - CY);
      if (dx > W2 || dy > OUT_HEX_R - dx / SQRT3) continue; // 六边形外（本来透明）
      const dEdge = Math.min(W2 - dx, (OUT_HEX_R - dy - dx / SQRT3) * 0.866);
      if (dEdge < HOLLOW_RING) d[(y * OUTPUT_W + x) * 4 + 3] = 0;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return out;
}

export default function SkinStudio() {
  const me = useAuth((s) => s.user);
  const updateUser = useAuth((s) => s.updateUser);

  // 源图与视图变换
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [fileName, setFileName] = useState('');
  const [fileInfo, setFileInfo] = useState('');
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [zoomText, setZoomText] = useState('100%');

  // 画布与容器
  const containerRef = useRef<HTMLDivElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  /** 最近一次预览渲染时的几何（宽/高/六边形半径）——裁剪导出必须用用户「看到」的那帧几何，
   *  否则左列出现裁剪结果后布局变化导致容器尺寸漂移，导出内容与预览不一致 */
  const previewGeomRef = useRef({ w: 0, h: 0, hexR: 60 });
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [resultReady, setResultReady] = useState(false);
  const [resultDataUrl, setResultDataUrl] = useState<string | null>(null);
  const [hollowDataUrl, setHollowDataUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // 指针（拖拽平移 + 双指缩放）
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; scale: number; midX: number; midY: number } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const getHexRadius = () => Math.max(60, Math.min(containerSize.w, containerSize.h) * 0.4);

  // 容器尺寸跟踪（预览画布按容器自适应，DPR 感知）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update);
      ro.observe(el);
    }
    window.addEventListener('resize', update);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const fitImage = () => {
    if (!img) return;
    const { w, h } = containerSize;
    if (w === 0 || h === 0) return;
    const hexR = getHexRadius();
    const sx = (hexR * Math.sqrt(3)) / img.naturalWidth;
    const sy = (hexR * 2) / img.naturalHeight;
    const s = Math.max(sx, sy);
    setScale(s);
    setOffset({ x: (w - img.naturalWidth * s) / 2, y: (h - img.naturalHeight * s) / 2 });
  };

  // 新图载入或容器尺寸变化时重置取景（cover 铺满六边形包围盒）。
  // 不能只在首次载入时 fit：布局（如 dvh 回落、滚动条出现）可能在载入后改变容器尺寸，
  // 旧 offset/scale 会让裁剪导出与预览错位。容器尺寸只随窗口变化，不影响用户缩放平移。
  useEffect(() => {
    if (!img || containerSize.w === 0 || containerSize.h === 0) return;
    fitImage();
  }, [img, containerSize]);

  // 预览渲染：棋盘底 + 图片 + 六边形遮罩/边框/顶点点
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const { w, h } = containerSize;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    drawCheckerboard(ctx, 0, 0, w, h);
    if (img) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, offset.x, offset.y, img.naturalWidth * scale, img.naturalHeight * scale);
    }
    const cx = w / 2;
    const cy = h / 2;
    const hexR = getHexRadius();
    previewGeomRef.current = { w, h, hexR };
    // 六边形外压暗（inside 保持明亮）
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    hexPath(ctx, cx, cy, hexR);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fill('evenodd');
    // 边框 + 顶点点
    ctx.beginPath();
    hexPath(ctx, cx, cy, hexR);
    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#4a9eff';
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 3;
      ctx.beginPath();
      ctx.arc(cx + hexR * Math.cos(a), cy + hexR * Math.sin(a), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    setZoomText(Math.round(scale * 100) + '%');
  }, [img, scale, offset, containerSize]);

  const applyZoom = (factor: number, mx?: number, my?: number) => {
    if (!img) return;
    const { w, h } = containerSize;
    const old = scale;
    const s = Math.max(0.01, Math.min(50, scale * factor));
    const ratio = s / old;
    const px = mx !== undefined ? mx : w / 2;
    const py = my !== undefined ? my : h / 2;
    setScale(s);
    setOffset({ x: px - (px - offset.x) * ratio, y: py - (py - offset.y) * ratio });
  };

  // 文件载入
  const loadImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('请上传图片文件');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const ni = new Image();
      ni.onload = () => {
        setImg(ni);
        setFileName(file.name);
        setFileInfo(formatSize(file.size) + ' · ' + ni.naturalWidth + '×' + ni.naturalHeight);
        setResultReady(false);
        setError(null);
      };
      ni.onerror = () => setError('图片加载失败，请尝试其他格式');
      ni.src = reader.result as string;
    };
    reader.onerror = () => setError('文件读取失败');
    reader.readAsDataURL(file);
  };

  const onFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) loadImageFile(f);
    e.target.value = '';
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) loadImageFile(f);
  };

  // 把当前取景（scale/offset）重投影到 192×216 输出画布（六边形 R=100 居中 + 深色内描边）
  const renderResult = (ctx: CanvasRenderingContext2D) => {
    const { w, h, hexR } = previewGeomRef.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, OUTPUT_W, OUTPUT_H);
    ctx.save();
    ctx.beginPath();
    hexPath(ctx, OUTPUT_W / 2, OUTPUT_H / 2, OUT_HEX_R);
    ctx.clip();
    const ratio = OUT_HEX_R / hexR;
    const s = scale * ratio;
    const tx = (offset.x - w / 2) * ratio + OUTPUT_W / 2;
    const ty = (offset.y - h / 2) * ratio + OUTPUT_H / 2;
    ctx.setTransform(s, 0, 0, s, tx, ty);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img!, 0, 0);
    // 深色内描边：先复位为单位变换（当前仍带图片变换），在六边形裁剪内绘制 → 仅内侧 ~3px，与本地旗帜边缘一致
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    hexPath(ctx, OUTPUT_W / 2, OUTPUT_H / 2, OUT_HEX_R);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.restore();
  };

  const doCrop = () => {
    if (!img) return;
    // 结果画布离屏生成（192×216），避免“先有 canvas 才可裁剪、裁剪后才渲染 canvas”的循环
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_W;
    canvas.height = OUTPUT_H;
    renderResult(canvas.getContext('2d')!);
    setResultDataUrl(canvas.toDataURL('image/png'));
    setHollowDataUrl(punchHollowRing(canvas).toDataURL('image/png'));
    setResultReady(true);
    setSuccess(null);
    setError(null);
  };

  // 确认：上传 solid + hollow 两张皮肤
  const doConfirm = async () => {
    if (!me || !resultDataUrl || !hollowDataUrl) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await uploadSkin(resultDataUrl, hollowDataUrl);
      updateUser({ ...me, hasSkin: true });
      setSuccess('皮肤已上传，在大厅 / 房间 / 对局中展示');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  // 指针事件：单指/鼠标拖动平移，双指捏合缩放（以两指中点为中心）
  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    (e.currentTarget as HTMLCanvasElement).setPointerCapture?.(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = {
        dist: Math.hypot(b.x - a.x, b.y - a.y),
        scale,
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
      };
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const p = pointersRef.current.get(e.pointerId);
    if (!p) return;
    if (pointersRef.current.size === 1) {
      if (pinchRef.current) {
        pinchRef.current = null;
      }
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      setOffset((o) => ({ x: o.x + dx, y: o.y + dy }));
      p.x = e.clientX;
      p.y = e.clientY;
    } else if (pointersRef.current.size === 2 && pinchRef.current) {
      const [a, b] = [...pointersRef.current.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (dist > 0 && pinchRef.current.dist > 0) {
        const rect = e.currentTarget.getBoundingClientRect();
        const mx = pinchRef.current.midX - rect.left;
        const my = pinchRef.current.midY - rect.top;
        applyZoom(dist / pinchRef.current.dist, mx, my);
      }
      p.x = e.clientX;
      p.y = e.clientY;
    }
  };

  const endPointer = (e: PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
  };

  const onWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    applyZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top);
  };

  const skinPreviewSrc = me?.hasSkin ? `/static/skin/usr_${me.id}.png?t=${Date.now()}` : null;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-slate-900 text-white">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-700 px-4 py-2.5 lg:px-6 lg:py-3">
        <h1 className="text-lg font-bold">个性皮肤</h1>
        <Link to="/profile" className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600">
          ← 返回个人中心
        </Link>
      </header>

      {/* 窄屏：上传图片改为一行（左侧按钮上传，右侧显示当前文件名）；桌面端仍用左栏的大块上传区 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-700 px-3 py-2 lg:hidden">
        <button
          onClick={() => document.getElementById('skin-file-input')?.click()}
          className="shrink-0 rounded bg-slate-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-600"
        >
          📁 上传图片
        </button>
        {fileName ? (
          <span className="min-w-0 flex-1 truncate text-xs text-slate-300">
            {fileName} · {fileInfo}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-slate-500">支持 JPG / PNG / GIF / BMP / WEBP 等格式</span>
        )}
      </div>
      {(error || success) && (
        <div className="shrink-0 px-3 py-1.5 text-xs lg:hidden">
          {error ? <span className="text-red-200">⚠ {error}</span> : <span className="text-emerald-200">✓ {success}</span>}
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col gap-4 lg:mx-auto lg:w-full lg:max-w-6xl lg:grid lg:grid-cols-[320px_1fr] lg:overflow-hidden lg:px-6 lg:py-6">
        {/* 左列：上传 / 当前皮肤 / 裁剪结果与确认（仅桌面；窄屏下省略，改用顶部单行上传 + 右下角控制条） */}
        <div className="hidden space-y-4 lg:block lg:min-h-0 lg:overflow-y-auto">
          {error && (
            <div className="rounded bg-red-900/50 px-3 py-2 text-sm text-red-200" role="alert">
              {error}
            </div>
          )}
          {success && (
            <div className="rounded bg-emerald-900/50 px-3 py-2 text-sm text-emerald-200" role="status">
              {success}
            </div>
          )}

          <section className="rounded-lg bg-slate-800 p-4">
            <h2 className="mb-3 text-sm font-bold text-slate-400">上传图片</h2>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => document.getElementById('skin-file-input')?.click()}
              className={`cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition ${
                dragOver ? 'border-emerald-400 bg-emerald-900/20' : 'border-slate-600 hover:border-emerald-500'
              }`}
            >
              <div className="text-3xl">📁</div>
              <p className="mt-2 text-sm text-slate-200">点击或拖放图片到此处</p>
              <p className="mt-1 text-xs text-slate-500">支持 JPG / PNG / GIF / BMP / WEBP 等格式</p>
            </div>
            <input
              id="skin-file-input"
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onFileInput}
            />
            {fileName && (
              <p className="mt-3 rounded bg-slate-700/50 px-3 py-2 text-xs text-slate-400">
                {fileName} · {fileInfo}
              </p>
            )}
          </section>

          <section className="rounded-lg bg-slate-800 p-4">
            <h2 className="mb-3 text-sm font-bold text-slate-400">当前皮肤</h2>
            {skinPreviewSrc ? (
              <div className="flex items-center gap-4">
                <img
                  src={skinPreviewSrc}
                  alt="当前皮肤"
                  className="h-[108px] w-24 object-contain"
                  style={{ imageRendering: 'pixelated' }}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.visibility = 'hidden';
                  }}
                />
                <p className="text-xs text-slate-400">上传新皮肤后将立即生效</p>
              </div>
            ) : (
              <p className="text-xs text-slate-500">尚未上传皮肤，完成右侧裁剪后点击「确认」上传</p>
            )}
          </section>

          <section className="rounded-lg bg-slate-800 p-4">
            <h2 className="mb-3 text-sm font-bold text-slate-400">裁剪结果</h2>
            {resultReady && resultDataUrl ? (
              <>
                <img
                  src={resultDataUrl}
                  alt="裁剪结果"
                  className="mx-auto rounded border border-slate-600"
                  style={{ width: 288, height: 324, imageRendering: 'pixelated' }}
                />
                <p className="mt-2 text-center text-xs text-slate-500">
                  生成 192×216 的 solid 与 hollow（断兵）两张皮肤
                </p>
                <button
                  onClick={() => void doConfirm()}
                  disabled={busy}
                  className="mt-3 w-full rounded bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {busy ? '上传中…' : '确认上传'}
                </button>
              </>
            ) : (
              <p className="py-4 text-center text-xs text-slate-500">
                尚未生成裁剪结果
                <br />
                上传图片后在右侧调整并点击「确认裁剪」
              </p>
            )}
          </section>
        </div>

        {/* 右列：裁切预览 + 控制栏（窄屏时占满剩余屏幕） */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-800 lg:rounded-lg">
          <div ref={containerRef} className="relative flex flex-1 items-center justify-center overflow-hidden">
            <canvas
              ref={previewCanvasRef}
              id="skin-preview-canvas"
              className={`${img ? '' : 'hidden'} cursor-grab active:cursor-grabbing`}
              style={{ touchAction: 'none' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endPointer}
              onPointerCancel={endPointer}
              onWheel={onWheel}
            />
            {!img && (
              <p className="px-4 text-center text-sm text-slate-500">
                🖼️ <span className="lg:hidden">请先点击上方按钮上传图片</span>
                <span className="hidden lg:inline">请先在左侧上传图片</span>
              </p>
            )}
            {/* 窄屏：裁剪一次后，在裁切界面右上角展示当前裁切预览 */}
            {resultReady && resultDataUrl && (
              <div className="absolute right-2 top-2 z-10 rounded-lg border border-slate-600 bg-slate-900/90 p-1.5 lg:hidden">
                <p className="mb-1 text-[10px] text-slate-400">当前裁切预览</p>
                <img
                  src={resultDataUrl}
                  alt="当前裁切预览"
                  className="h-24 w-auto rounded border border-slate-700"
                  style={{ imageRendering: 'pixelated' }}
                />
              </div>
            )}
          </div>
          <div className="hidden flex-wrap items-center gap-3 border-t border-slate-700 p-3 lg:flex">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">缩放</span>
              <button
                onClick={() => applyZoom(1 / 1.25)}
                className="h-8 w-8 rounded border border-slate-600 bg-slate-700 text-lg leading-none text-white hover:bg-slate-600"
                title="缩小"
              >
                −
              </button>
              <span className="min-w-[50px] text-center text-xs text-slate-400 tabular-nums">{zoomText}</span>
              <button
                onClick={() => applyZoom(1.25)}
                className="h-8 w-8 rounded border border-slate-600 bg-slate-700 text-lg leading-none text-white hover:bg-slate-600"
                title="放大"
              >
                +
              </button>
              <button
                onClick={fitImage}
                className="h-8 w-8 rounded border border-slate-600 bg-slate-700 text-white hover:bg-slate-600"
                title="重置位置"
              >
                ↻
              </button>
            </div>
            <span className="hidden text-xs text-slate-500 sm:inline">滚轮缩放 · 拖动平移 · 双指捏合</span>
            <div className="flex-1" />
            <button
              onClick={doCrop}
              disabled={!img}
              className="rounded bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              确认裁剪
            </button>
          </div>

          {/* 窄屏：右下角浮动控制条（缩放 / 重置 / 裁剪 / 确认上传） */}
          <div className="pointer-events-none absolute bottom-2 right-2 z-20 lg:hidden">
            <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-slate-600 bg-slate-800/95 p-1.5 shadow-lg">
              <button
                onClick={() => applyZoom(1 / 1.25)}
                className="h-9 w-9 rounded-lg bg-slate-700 text-lg leading-none text-white hover:bg-slate-600"
                title="缩小"
              >
                −
              </button>
              <span className="min-w-[44px] text-center text-xs text-slate-400 tabular-nums">{zoomText}</span>
              <button
                onClick={() => applyZoom(1.25)}
                className="h-9 w-9 rounded-lg bg-slate-700 text-lg leading-none text-white hover:bg-slate-600"
                title="放大"
              >
                +
              </button>
              <button
                onClick={fitImage}
                className="h-9 w-9 rounded-lg bg-slate-700 text-white hover:bg-slate-600"
                title="重置位置"
              >
                ↻
              </button>
              <button
                onClick={doCrop}
                disabled={!img}
                className="h-9 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                裁剪
              </button>
              <button
                onClick={() => void doConfirm()}
                disabled={!resultReady || busy}
                className="h-9 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                {busy ? '上传中…' : '确认上传'}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
