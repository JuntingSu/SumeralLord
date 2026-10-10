/**
 * io.js — JSON 导入/导出、服务器保存与加载
 * 导出/保存均剔除 id 字段（地图文件内不含 id，id 由文件名派生）；文件允许 // 行注释。
 */
const IO = (() => {
  /** 剥离 // 行注释（与 backend/src/maps/catalog.ts 的 stripJsonComments 一致） */
  function stripJsonComments(raw) {
    let out = '';
    let inString = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        out += ch;
        if (ch === '"') inString = false;
        else if (ch === '\\') {
          out += raw[i + 1] ?? '';
          i++;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        out += ch;
        continue;
      }
      if (ch === '/' && raw[i + 1] === '/') {
        while (i < raw.length && raw[i] !== '\n') i++;
        out += '\n';
        continue;
      }
      out += ch;
    }
    return out;
  }

  function parseMapJson(text) {
    try {
      const map = JSON.parse(stripJsonComments(text));
      return { ok: true, map };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** 导出为 JSON 文件下载 */
  function downloadMap(map, id) {
    const data = JSON.stringify(MapData.serialize(map), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(id || 'map').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function base(url) {
    return (url || '').replace(/\/+$/, '');
  }

  /** 当前登录 token（主程序 localStorage 的 dl_token；与 auth/client.ts 一致） */
  function authToken() {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem('dl_token') : null;
    } catch {
      return null;
    }
  }

  /** 保存到服务器：达标玩家直存 maps，其余走 maps-uncensored 审查队列 */
  async function saveToServer(baseUrl, id, map) {
    const token = authToken();
    const resp = await fetch(`${base(baseUrl)}/api/maps`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ id, map: MapData.serialize(map) }),
    });
    const result = await resp.json().catch(() => ({}));
    return { ok: resp.ok && result.success, status: resp.status, result };
  }

  /** 加载服务器地图列表；search 非空时按标题/作者/简介/tags 匹配（复用后端 /api/maps?search=） */
  async function loadServerMapList(baseUrl, search) {
    const q = search ? `?search=${encodeURIComponent(search)}` : '';
    const resp = await fetch(`${base(baseUrl)}/api/maps${q}`);
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok || !result.success) throw new Error(result.message || '加载地图列表失败');
    return result.data?.mapList || [];
  }

  async function loadServerMap(baseUrl, id) {
    const resp = await fetch(`${base(baseUrl)}/api/maps/${encodeURIComponent(id)}`);
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok || !result.success) throw new Error(result.message || '加载地图失败');
    return result.data;
  }

  /**
   * 当前登录账号的公开统计（积分 score / 对局数 matches），用于上传前的免审核资格判断。
   * 未登录（无 token）时抛错，调用方按「无免审核资格」处理。
   */
  async function loadMyStats(baseUrl) {
    const token = authToken();
    const resp = await fetch(`${base(baseUrl)}/api/users/me`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok || !result.success) throw new Error(result.message || '获取账号信息失败');
    const u = result.data?.user ?? {};
    return { username: u.username ?? '', score: Number(u.score) || 0, matches: Number(u.matches) || 0 };
  }

  return { stripJsonComments, parseMapJson, downloadMap, saveToServer, loadServerMapList, loadServerMap, loadMyStats };
})();
