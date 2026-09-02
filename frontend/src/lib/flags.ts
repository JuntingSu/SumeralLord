// 旗帜图片 URL 派生（个人皮肤约定：flag 为负数 = 使用 -flag 号玩家的皮肤，正数 = 内置旗帜编号）。
// 皮肤文件位于 backend/static/skin/usr_{id}.png / usr_{id}_hollow.png，由 @fastify/static 经 /static/** 提供。
export function flagImgUrl(flag: number): string {
  return flag < 0 ? `/static/skin/usr_${-flag}.png` : `/static/flags/flag_${flag}.png`;
}

export function flagHollowImgUrl(flag: number): string {
  return flag < 0 ? `/static/skin/usr_${-flag}_hollow.png` : `/static/flags/flag_${flag}_hollow.png`;
}

/** 用户头像：已上传个人皮肤时优先展示皮肤，否则用默认旗帜 */
export function avatarUrl(id: number, flag: number, hasSkin: boolean): string {
  return hasSkin ? `/static/skin/usr_${id}.png` : `/static/flags/flag_${flag}.png`;
}
