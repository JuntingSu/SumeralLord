// 旗帜图片 URL（回放查看器本地版）：资源位于 public/flags/，由 vite 以 /flags/** 提供。
// flag 为负数 = 原服务端个人皮肤约定，本地无皮肤文件 → 回退同编号内置旗帜（不存在时 BoardCanvas 走色块兜底）。
export function flagImgUrl(flag: number): string {
  return `/flags/flag_${Math.abs(flag)}.png`;
}

export function flagHollowImgUrl(flag: number): string {
  return `/flags/flag_${Math.abs(flag)}_hollow.png`;
}
