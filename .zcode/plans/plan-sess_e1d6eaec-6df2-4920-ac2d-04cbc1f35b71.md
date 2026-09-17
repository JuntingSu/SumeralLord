## 修复计划（分支 bugfix/mobile-ui-and-search-fixes）

### Bug 1：自定义皮肤界面对移动端适配（frontend/src/pages/SkinStudio.tsx）

参考 V5 生成器的移动端设计（隐藏左栏/控制栏，改用紧凑浮动控件），为窄屏（`< lg`，沿用项目现有桌面断点约定）重排布局：

1. **新增媒体查询 hook**（内联在 SkinStudio.tsx 或新建 `frontend/src/lib/useMediaQuery.ts`）：用 `window.matchMedia('(max-width: 1023px)')` + 惰性初始化（首帧不闪跳），检测窄屏 `isNarrow`。
2. **按 `isNarrow` 条件渲染两套布局**（共用同一个 preview canvas 与 containerRef，避免 DOM 中出现两个 canvas）：
   - **桌面（≥lg）**：保持现有双栏布局与左栏（上传/当前皮肤/裁剪结果）完全不变。
   - **窄屏**：
     - 根容器改 `h-dvh flex flex-col overflow-hidden`（占满屏幕、无需滚动，满足需求 e）。
     - 顶部保留 header（标题 + 返回）。
     - **上传改一行**（需求 a）：`[📁 按钮] [文件名 · 大小·尺寸]`，按钮触发隐藏 file input；未上传时右侧显示格式提示文字。原大块虚线拖放区、当前皮肤区、裁剪结果区均省略（“省略不必要内容”），拖放支持保留（canvas 容器仍可 drop）。
     - 剩余空间全部给裁切 canvas（`flex-1 relative overflow-hidden`）。
     - **裁剪结果预览**（需求 c）：`resultReady` 时在 canvas 区**右上角**叠加显示缩略图 + “当前裁切预览”标签。
     - **底部右下角浮动控制条**（需求 b/d）：`[−] [100%] [+] [↻] [裁剪] [确认上传]`，缩放/重置/裁剪在左、**确认上传**在最右侧（disabled 逻辑与 busy 状态复用现有 `doConfirm`/`busy`）。
     - error/success 提示以紧凑单行显示。
   - 所有缩放/平移/滚轮/双指/裁剪/上传逻辑与状态（scale/offset/fitImage/doCrop/doConfirm/loadImageFile 等）原样复用，仅改布局。

### Bug 2：窄屏对局界面结束行动/加点按钮被对话框遮挡（frontend/src/pages/Game.tsx）

- 将第 613 行按钮定位从固定 `bottom-14` 改为响应式：窄屏（`< lg`）抬高到 `bottom-84`（336px，高于展开的聊天对话框顶部约 320px，满足“对话框不遮挡按钮”），桌面 `lg:bottom-14` 保持现状。
- 实施后会在窄屏实机渲染中核对偏移量，必要时微调数值。

### Bug 3：地图搜索栏清空后不再显示列表（frontend/src/components/MapPicker.tsx）

根因：清空按钮 `onMouseDown preventDefault` 保持输入框焦点；点击清空后 `setOpen(false)` 关闭列表但输入框仍有焦点，之后再次点击输入框不触发 `onFocus`，列表不再打开（需先点别处失焦再点回）。

修复（一处组件，CreateRoom/Room 两个使用点同时生效）：
1. 清空按钮 `onClick` 中把 `setOpen(false)` 改为 `setOpen(true)`：清空后列表立即展示全部地图（query 为空 → `results = maps`）。
2. 给 input 增加 `onClick={() => setOpen(true)}`：即使输入框已有焦点，点击也重新打开列表。

### 验证
- `cd frontend && npm run typecheck`
- 启动 dev 服务器，用浏览器窄屏视口（如 390×844 手机）逐一核对三处改动；确认皮肤界面无需滚动、按钮不被聊天遮挡、地图清空后列表立即可见。

### 涉及文件
- `frontend/src/pages/SkinStudio.tsx`（主要改动）
- `frontend/src/pages/Game.tsx`（1 处 className）
- `frontend/src/components/MapPicker.tsx`（2 处小改动）
- 可能新增 `frontend/src/lib/useMediaQuery.ts`（如内联则不改此文件）