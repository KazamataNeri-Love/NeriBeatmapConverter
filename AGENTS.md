# AGENTS.md — NeriBeatmapConverter 工程宪法

本文件是所有进入本仓库的 AI 代理必须首先遵守的硬性规范。

- **正式项目名**：`NeriBeatmapConverter`（GitHub：`KazamataNeri-Love/NeriBeatmapConverter`）
- **当前本地目录**：`D:\SongPacks\Tools\SeriousBeatmapConverter\`（目录暂沿用旧名，以本仓库根目录为准）

## 1. 仓库边界与严格隔离
- **唯一可写主仓**：`D:\SongPacks\Tools\SeriousBeatmapConverter\`（本仓库）。
- **严格只读参考工程**（位于上级 `../_references/`）：
  - `../_references/BmsToOsu-dev/`（.NET，AGPL-3.0）
  - `../_references/o2jam-to-osu/`（Java）
  - `../_references/o2jam-to-osu.jar`、`../_references/audio-sample-mixer.exe`
  - **禁令**：仅允许定向查证格式/时间轴/协议细节；严禁修改、严禁引入运行时依赖、严禁复制或转译外部源码（防止 AGPL/LGPL 污染本仓 MIT 许可）。
- **仓外基线**：`../_qa/`（`OfficialBeatmaps/`、`baseline/` 等）与 `../_shots/` 只读不改，禁止将大音频/曲包拷入本仓。

## 2. 三角色分工（写审分离 + 异构配模）
| 角色 | 推荐模型 | 职责边界 | 严禁越权 |
|---|---|---|---|
| **① 流程与架构总控** | Gemini | 定规范、守架构边界、拆 Issue（含 `Non-Goals` / 文件白名单 / 样板 / 测试命令） | 绝不修改业务代码；不背诵整仓源码细读 |
| **② 版本总管 / 盲审官** | GPT | 分支集成、**仅 1 轮基于 `git diff` 的盲审**、必要极小快修、交付 4 行盲审卡 | 未获人类明确回复「**批准合并**」前，严禁 `push` / 建 PR / 合并 / 关单 |
| **③ 独立施工车间** | DeepSeek 等异构模型 | **1 Issue 1 窗**，严格按白名单与样板实现，跑通验收命令，**本地 commit 即止**，交付 4 行交接单 | 严禁超出白名单改文件；严禁 `push` / 建 PR / 合并 / 关单 |

## 3. 架构分层边界（Parser → 统一 IR → Emitter）
- `src/core/`（Kernel）：格式无关的公共能力与唯一 `.osu` 写出器（`src/core/osu/writer.js`）。
- `src/modes/<format>/`（模式层）：各谱面格式的 Parser、IR 映射、Pipeline 与 Panel。
- `src/ui/shell.js`（外壳层）：唯一操作 DOM 的总入口。
- `tools/`（CLI / 服务 / 打包 / 测试）：薄适配层，核心转换逻辑必须留在 `src/`。
- **硬原则**：新增/修改谱面格式优先遵循 `Parser → 统一 IR → Emitter` 解耦，禁止绕过 `src/core/osu/writer.js` 私拼 `.osu`。

## 4. 转换器专属质量防线（盲审 3 红线）
任何改动触犯以下任一条，盲审直接打回：
1. **数值精度 / 编码 / 静默丢音符**：引入时间轴浮点漂移、小数时间戳、PCM `int16` 环绕、Shift-JIS/GBK/UTF-8 编码退化，或缺样本时静默丢弃音符。
2. **越界改 IR 或无关格式**：超出 Issue 文件白名单；未在 Issue 授权下擅改 `src/core/` 公共契约，或修改一个模式（如 BMS）却牵连/破坏另一个模式（如 O2Jam）。
3. **破坏确定性或既有 Golden 回归**：同输入产生非确定性输出（乱序、时间戳污染、重名 ZIP 条目）或破坏 O2Jam 逐字节 / BMS 逐毫秒回归基线。

## 5. Golden 样本与体积红线
- 主仓**严禁提交**大体积音频（`.mp3`/`.wav`/`.ogg`/`.flac`/`.m4a`）、曲包压缩包（`.osz`/`.zip`/`.rar`/`.7z`）或 `.ojn`/`.ojm` 二进制曲库资源。
- 仓内 Golden 样本仅允许极小纯文本谱面（如精简 `.bms` / 合成测试数据 + 期望 `.osu` 文本快照）。
