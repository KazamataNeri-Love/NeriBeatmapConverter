# ROADMAP.md — NeriBeatmapConverter 路线图与批次台账

> **维护规则**：由 ②-A（GPT 日常总管）日常维护，②-B 合并 PR 后顺手勾选；换版或改向直接升修订号（如 `v0.4-r1 → v0.4-r2`）并记录变更摘要，不维护重度 Milestone。

## 当前批次：`v0.4-r1`（规划待填充，上限 3~5 张 Issue）
- 原则：白名单有交集（尤其触碰 `src/core/`）必须串行，标明前置依赖。
- 候选起盘项（供与 ②-A 讨论后正式定序与建单）：
  - [ ] *(待建单)* 统一项目展示名与包名为 `NeriBeatmapConverter`（首单全链路演练）
  - [ ] *(待建单)* 补齐仓内极小纯文本 Golden 样本与无仓外 `OfficialBeatmaps` 自包含回归（ADR-003）

## 下一批次候选（Next）
- BMS P1：`#LNTYPE 2` 完整语义、DP 14K 实战校验、`#RANDOM` 多重嵌套实测
- 公共装配层收拢（`src/core/assemble.js`）—— *动 `src/core/` 前须由 ① Gemini 拍板契约*

## 远期构想池（Later / Ideas，仅记录不排期）
- BGA → 视频/故事板（`[Events]` Sprite/Video）
- 新格式扩展：PMS 9K / bmson / `iidx2bms`
- 浏览器侧开放 OGG 选项 / 谱面预览

---

## 换版记录（纠错与改向日志）
- `v0.4-r1`（初始基线）：完成治理宪法落盘与低耗 Gemini 四席位架构定型，待 ②-A 与人类敲定首批正式 Issue。
