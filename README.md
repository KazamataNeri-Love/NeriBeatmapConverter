# SeriousBeatmapConverter

音游谱面 → osu! mania 转换台（O2Jam / BMS，可扩展）。一个页面、一套命令行，把多种来源的谱面转成 osu! mania：

| 模式 | 输入 | 一首歌 = | 状态 |
|---|---|---|---|
| **O2Jam** | `.ojn` + 同名 `.ojm` | 一个 `.ojn`（内含 EX/NX/HX） | 稳定（原 O2Jam-2-osu 全部能力，产物逐字节不变） |
| **BMS** | `.bms/.bme/.bml/.bmx` + 样本 | 一个文件夹（每个 `.bms` 一个难度） | P0 可用（5K/5K1S/7K/7K1S/10K/10K2S/14K/14K2S、变速 / STOP / 小节长度 / LN / 键音 / 混音） |

两条路子，共用同一套转换代码：

| | 浏览器 | 命令行（推荐批量） |
|---|---|---|
| 启动 | `npm start` → 拖入文件，按扩展名自动分诊 | `node tools/cli.js [o2jam\|bms\|auto] --in <目录> --out <目录>` |
| MP3 编码 | **也是系统 ffmpeg**（页面把 PCM POST 给本地服务） | 系统 ffmpeg |
| 探测不到 ffmpeg 时 | 自动退回内置 lamejs（纯 JS，4 分钟歌约 20 秒） | 无退路（键音 / 无音频模式不需要 ffmpeg） |
| 实测吞吐 | O2Jam 约 1.5 秒/首；BMS 混音约 1.5 秒/首（3 路并行） | O2Jam 1.8 秒/首；BMS 混音约 1.5 秒/首 |
| 需要 | 用 `npm start` 启动（ES 模块不能双击 html） | 装了 ffmpeg（`winget install Gyan.FFmpeg`） |

> 早期版本是单文件 `o2jam2osu.html`（零依赖、可直接双击）。现在分成 **kernel（`src/core/`）+ 模式（`src/modes/`）+ 外壳（`src/ui/shell.js`）** 三层：
> 加一个新来源只需要新建一个目录，不必碰 `.osu` 写出器。ES 模块必须经 http 加载，所以请用下面的方式启动。

## 快速开始：浏览器

```bash
npm start          # → http://localhost:5173/   （Windows 也可直接双击 start.cmd）
```

没有 Node 也行，任意静态服务器都可以（`python -m http.server`、VS Code 的 Live Server 等）。
然后：**把 `.ojn`/`.ojm` 或整个歌曲文件夹拖进页面 → 勾选要转的难度 → 开始转换**。

> ⚠ **不要直接双击 `index.html`**。本项目的代码全部是 ES 模块，浏览器不允许从 `file://` 加载
> （控制台会报 `origin 'null' has been blocked by CORS policy`），表现为「页面能看，但标签页、
> 列表、按钮全点不动」。真双击了也不会一头雾水 —— 页面顶部会弹出提示条、标签页置灰，
> 并给出 `start.cmd` / `npm start` 两步。
>
> 想要「双击即用、不需要 Node」，用**单文件版**：`npm run bundle` 生成 `dist/hub.html`
> （≈340 KB，已内联全部代码与 lamejs），双击它就能完整使用（仅「本地 ffmpeg 加速」不可用，
> 自动退回内置 lamejs）。改过 `src/` 之后记得重新 `npm run bundle`。

页面上有个「本地 ffmpeg 编码」开关（默认开）。用 `npm start` 启动时，那个本地服务会去调**系统 ffmpeg**
编 MP3，所以网页端的编码速度和命令行一样（约 150× 实时，4 分钟歌约 1.5 秒）—— 不需要下载 32MB 的 ffmpeg.wasm。
探测不到 ffmpeg（或用 Live Server 之类打开）时，那一行会提示原因、开关变灰，并**自动退回内置 lamejs**：
功能完全不受影响，只是慢一些（约 10× 实时）。

## 快速开始：命令行（整库批量）

```bash
# O2Jam（老命令照旧：不带子命令 = auto，输入里只有 .ojn 就跑 O2Jam）
node tools/cli.js --in ..\OfficialBeatmaps --out ..\osz          # 整库，默认 3 难度 + 共享混音 + MP3 320k
node tools/cli.js o2jam --in <目录> --format keysound            # 保留键音（不混音）
node tools/cli.js --in <目录> --limit 5 --verbose                # 试跑 5 首，打印每步日志
node tools/cli.js --in <目录> --skip-existing                    # 断点续跑

# BMS
node tools/cli.js bms --in "D:\BMS 曲包" --out ..\bms-osz         # 默认 MP3 320k，键型自动（5K1S/7K1S/14K2S…）
node tools/cli.js bms --in <目录> --format keysound              # 保留键音（BMS 原生玩法，最快）
node tools/cli.js bms --in "D:\曲包\*.zip 所在目录"                # 压缩包直读，不用解压
node tools/cli.js bms --in <目录> --plate drop --keys 7k         # 皿丢弃、强制 7K
node tools/cli.js bms --in <目录> --keys 5k1s                    # 强制 5 键 + 单皿（6 列）
node tools/cli.js bms --in <目录> --keys 14k2s                   # 强制双人 7+7 + 双皿（16 列）
node tools/cli.js bms --in <目录> --no-stop --random 2           # 忽略 STOP、#RANDOM 取第 2 支

node tools/cli.js --help                                         # 全部参数
node tools/verify-osz.js ..\osz                                  # 验收产物：能不能真的导入 osu!
```

### 压缩包直读（不用解压）

BMS 单曲常以压缩包分发，一个个解压很烦，而且源目录有时还需要管理员权限。现在可以直接把压缩包丢进去：

| 格式 | 处理方式 | 需要什么 |
|---|---|---|
| `.zip` | **内存里摊平**（只读中央目录，样本用到才解压，不落盘） | 无（Node 用 zlib，浏览器用 `DecompressionStream`） |
| `.rar` / `.7z` | 调 **7-Zip / UnRAR** 解到**系统临时目录** | 装 7-Zip（或用 `SBC_7Z` 指向 `7z.exe`）；WinRAR 的 `UnRAR.exe` 也认 |

- 源压缩包只被**读**，不在它旁边创建任何文件 —— 这正是不需要管理员权限的原因；
- 临时目录在跑完后自动删除；
- 一个压缩包 = 一首歌（包内的顶层文件夹即歌曲目录）；`.zip` 里套 `.zip` 不支持，会跳过并提示；
- 加密压缩包会明确报「加密条目，跳过」，不会读出乱码；
- **浏览器版只支持 `.zip`**（拿不到子进程）；`.rar/.7z` 会提示改用命令行或先解压。

实测（`D:\BaiduNetdiskDownload\Beatmania IIDX ZIP` 里的 5 个 RAR，含 EZ2/DP 双谱）：5 首 / 30 难度，**2.6 秒**转完，`verify-osz` 全过。

几个要点：

- **O2Jam 混音必须有 ffmpeg**（要 `libmp3lame`；gyan.dev / BtbN 的 full build 都有）。没有就只能在命令行用 `--audio none`。
  **BMS 用 `--format keysound` 不需要 ffmpeg**（样本原样拷进图包）。
- `--jobs` 默认 `min(6, 核数-1)`。ffmpeg 自己吃多核，开太大反而互相抢。
- 默认 `--audio shared`（一首歌的多个难度共用一份混音）—— 比浏览器默认的 `per-diff` **省 2/3 的编码时间与体积**。
- **BMS 的 `--plate`**：`column`（默认，皿占一列；旧名 `8k` 仍可用）/ `sample`（皿只当背景音播放）/ `drop`（直接丢）。
  皿的通道是 `16`（左手，落最左）与 `26`（右手，落最右）；长音皿是 `56` / `66`。
- **BMS 的 `--keys`**：`auto`（默认）/ `5k`（5 列）/ `5k1s`（6）/ `7k`（7）/ `7k1s`（8）/
  `10k`（10）/ `10k2s`（12）/ `14k`（14）/ `14k2s`（16），也可以直接写列数。
- 失败/警告都进 `--out` 下的 `_report.json`，`--verbose` 会打印每首的逐行日志。
- 中途 Ctrl-C 会清理临时文件（否则一次中断会在 `%TEMP%` 里留下几百 MB 的 raw）。

## 项目结构

```
index.html                   页面骨架（tab + ①选曲 ②选项 ③列表 ④转换）
src/
  core/                      ── kernel：与来源格式无关 ──
    osu/writer.js            ★ 全项目唯一拼 .osu 的地方（模板 / 格式化 / 自检）
    audio.js                 混音（audioObjects + samples → Float32 PCM）
    keysound.js              保留键音：音频轨选取 + [Events] Sample 行 + 样本清单
    encoders/                编码器注册表 + WAV/MP3(lamejs)/ffmpeg-http
    text.js                  文本编码检测（GBK 系优先，见下）
    zip.js                   ZIP 写出（store）+ CRC32 → .osz
    unzip.js                 ZIP 读取（中央目录 + deflate，浏览器/Node 双后端）→ 曲包直读
    sampledur.js             纯 JS 样本时长（ogg/wav）
    util.js                  常量、日志、文件名清洗
  modes/o2jam/               ── O2Jam ──
    ojn.js                   OJN 头 + 音符块解析
    ojm.js                   OJM 样本解析（M30 / OMC / 明文 OJM）
    chart.js                 OJN 事件 → 中间表示（含异常修正）
    samples.js               样本 id 兜底（±1000 / 单主音频）
    pipeline.js              单曲流水线（3 难度、封面、共享混音）
    panel.js                 模式面板（列表 / 预览 / 转换）
  modes/bms/                 ── BMS ──
    bms.js                   文本解析（头信息 / #WAV / #BPMxx / #STOPxx / #RANDOM 分支 / 编码）
    chart.js                 拍→毫秒时间轴（变速 / STOP / 小节长度）+ 列布局 + LN/LNOBJ
    song.js                  文件夹→歌曲、#WAV 路径解析、封面回退
    pipeline.js              单曲流水线（多难度、键音 / 混音）
    panel.js                 模式面板
  ui/shell.js                tab、共用选项、拖入分诊、进度、日志、下载、编码器探测
  index.js                   统一出口（barrel）：kernel 扁平导出 + `C.bms.*` 命名空间
vendor/lamejs/lame.min.js    本地化的 MP3 编码器（离线可用）
tools/
  serve.js                   零依赖静态服务器 + 本地 ffmpeg 接口（/api/ffmpeg、/api/encode）
  bundle.mjs                 单文件打包器：src/ 全部模块 → dist/hub.html（file:// 可直接双击）
  cli.js                     命令行批量转换（o2jam / bms / auto 三个子命令）
  verify-osz.js              验收产物：结构/CRC/AudioFilename/样本引用/音频能不能盖住谱面
  lib/ffmpeg.js              ffmpeg 封装：批量解码样本、编码 MP3/OGG、冒充 AudioContext
  lib/archives.js            .rar/.7z 解压封装：找 7-Zip/UnRAR、解到临时目录
  test-suite.js              276 项回归测试（npm test）
  scan-shift.js              量化「Note 整体提前」的偏移量（npm run scan）
  scan-keysound.js           量化保留键音模式（npm run scan:keysound）
  scan-audio.js              样本容器/可解性/音频长度扫描（npm run scan:audio）
  scan-missing.js            统计“音乐缺失”的真实情况（npm run scan:missing）
  diag-mix.js                混音质量诊断：峰值/削波、与「键音等效求和」的一致性（需要系统 ffmpeg）
  diag-clip.js               证明/回归「浮点→int16 环绕」这个杂音 bug（npm run scan:clip，需 ffmpeg）
  diag-pipeline.js           真实管线复现（用 ffmpeg 冒充浏览器解码，跑完整 convertOneSong）
  diag-ffmpeg-verify.js      三条不变量：WAV 解码逐样本一致、MP3 往返相关系数、批量/逐个解码同结果
  diag-ffmpeg-batch.js       批量解码/编码的分批调优探针
  diag-ffmpeg-api.js         端到端验证「浏览器 → 本地 ffmpeg」：声道不串、往返相关系数、错误处理
  diag-big-post.js           大请求体（最大 100MB）压力测试：fetch 与 http.request 两条客户端路径
  diag-loudness.js           响度诊断：用 ebur128 量出输出比原曲母带低多少 dB
  diag-mp3-perf.js           lamejs 块大小/码率基准（多轮交错取中位数，避免被噪声骗）
  diag-perf.js               分阶段计时（解析/混音/编码）
  diag-song-audio.js         单曲逐难度样本 id 对照
  diag-m30.js / diag-m30-hex.js   容器结构探查
  diag-sampledur.js          纯 JS 时长解析对 ffmpeg 的校验
```

## 音频输出

有两种截然不同的思路，页面上的「音频」下拉框对应：

### A. 混音（默认 `每难度单独混音`）
把 BGM + 按键音全部混成一条音频，行为和原版 `o2jam-to-osu` 一致（它靠外部 exe，本工具在浏览器里做）。

| 格式 | 体积（4 分钟） |
|---|---|
| **MP3 320k**（默认） | ≈ 9.2 MB |
| MP3 128k | ≈ 3.7 MB |
| WAV | ≈ 40 MB |
| OGG/Vorbis（仅命令行 + ffmpeg） | ≈ 7 MB |

### B. 保留键音（`keysound`，不混音、不重编码）
思路来自 [BmsToOsu](../../_references/BmsToOsu-dev) 的默认行为（它只有 `--generate-mp3` 时才用 ffmpeg 混音）：

- BGM（OJN 的 `AUTO_PLAY` 通道）→ `[Events]` 的 `Sample,<time>,0,"<file>",<vol>` 行，在**原时间点**播放原样本；
- 如果某个难度里恰好有“只出现一次且就在开头”的整首 BGM 样本，就拿它当 `AudioFilename`（原始 .ogg 直接拷，不重编码）；否则不写 `AudioFilename`；
- 每个音符自带的样本 → 写进该音符的 `hitSample`（`0:0:0:<vol>:<file>`），**命中时才响**，和原版 O2Jam / BMS 一致；
- 用到的样本文件原样拷进图包。

全库实测（1001 首 / 2995 难度）：样本总量 **5446 MB**，混音 MP3@320 估算 **17777 MB** → **省约 69%**；
245 万条 BGM 事件中只有 136 条被用作音轨，其余全部保留。

```bash
npm run scan:keysound     # 量化整库：键音覆盖率、音轨选取、体积对比
```

> 代价：键音要点中才响（需要开打击音效），且没有整首 BGM 的谱面不会有背景音乐。

按键音属于谱面数据、三个难度各不相同，所以混音模式默认「每个难度各混一份」并各自带音频文件（与原版一致，osu! 会识别成一张三难度的图）。

### 混音质量：三个已修的听感问题（都用数据定位过）

1. **MP3 的整数环绕**（真正的“兹拉兹拉”元凶，2026-09-21 定位）：
   浮点→int16 时写的是 `int16[i] = v * 0x7FFF`，而 **Int16Array 的赋值是 mod 65536 环绕、不是饱和** ——
   一个 +2.0 的采样点变成 65534 → 存成 **−2**（符号翻转）。实测 **66.7% 的采样点符号被翻转**，
   编出的 MP3 与正确波形相关系数只有 **0.264**（垃圾）；而 WAV 路径一直是钳位的，
   所以出现「WAV 没事、MP3 有杂音」。只有 |v| > 1 才触发 → **关掉峰值归一化后必然复现**。
   → 现在两条路径共用 `src/encoders/pcm.js` 的 `floatToInt16`（先钳位、再 `|0` 截断），
   MP3 相关系数回到 **1.00000**，同时 WAV 输出保持**逐字节不变**。
   验证：`npm run scan:clip`（造过载正弦 → 编码 → ffmpeg 解回 → 比相关系数）。
2. **硬削波**：即使钳位正确，密集按键音叠加后峰值仍达 **+8.9 dBFS**（o2ma100 有 7.31% 采样点超 1.0），
   饱和会带来平顶失真（过载 6dB 时 MP3 重建平均误差 2.19%FS）→ 默认**峰值归一化到 -1 dBFS**
   （单一增益，不动动态关系）；关掉时会明确警告“会被饱和削波”。
3. **声像法则**：以前用等功率（居中 = 每声道 ×0.707 → 整体 -3dB），而保留键音模式下这些样本由 osu 自己播
   （不做声像、幅度原样）→ 实测平均差 12.40%FS，听感“不一致”。改成**平衡式**后，
   与「键音等效求和」的相关系数 **1.000000、平均差 0.00%FS**。

### OJM 的两种形态（判定“缺音乐”的前提）

踩过两次坑后确认，OJM 常见两种形态，**不能用同一把尺子量**：

| 形态 | 特征 | 谱面上的表现 |
|---|---|---|
| **BGM 型** | 有 1~几条长约 3~4 分钟的主音频（`bgm1` / `60_bgm` 之类） | 音符引用的键音 id **大多不在 OJM 里** —— 这很正常，那些音符本来就没声，音乐来自 `AUTO_PLAY` 通道 |
| **纯键音型** | 没有长样本，几百个短样本 | 音乐就是按键音按时间轴拼出来的 |

所以：
- 「音符引用不到样本」**≠** 缺音乐（必须分通道看）
- 「OJM 没有长样本」**≠** 不配套
- 真正会“整首没声音”的只有：**`AUTO_PLAY`（BGM）通道引用的样本不在 OJM 里**，或 BGM 型却连那条主音频都对不上

用正确的模型重扫 `OfficialBeatmaps`（1001 首 / 2995 难度）：

```
OJM 形态：BGM 型 556 首，纯键音型 440 首
音乐能盖到 ≥90% 谱面：2976 个难度（99.4%）
只盖到 <90%         ：2 个难度（o2ma1228「舞娘」79%、o2ma3978 88% —— BGM 样本本身不够长）
BGM 引用对不上      ：15 个难度（其中绝大多数靠键音把音乐补上了）
完全没音乐          ：0 首
```

### 样本 id 兜底（默认开，UI 可关）

现实里的 OJN/OJM 并不总是严格配套，谱面引用的 id 会“差一点点”，直接查表就整首没声。两种已实测到的情况：

1. **±1000 音色库偏移**：OJM 里的样本是 OGG（id = ref），而谱面写的是 WAV 库编号（id = 1000 + ref）——
   例：`o2ma3510`（OJM 里主音频 id=0，谱面 BGM 引用 1000）。
2. **只有一条主音频**（就像 osu 那样整首歌一条音频）：谱面 BGM 引用一个不存在的 id，而 OJM 里恰好只有一条
   **长度达到谱面一半**的样本——例：`o2ma3776` EX（OJM 只有 id=1000 的 209.8s 主音频，谱面 BGM 引用 1）。

严格分通道的保守规则：

- 精确 id 优先；否则试 ±1000 别名（BGM 与键音都可用）；
- **单主音频只给 BGM** —— 否则 `o2ma3776` 的 398 个键音会同向同一首歌，实测峰值冲到 **109**（归一化 -41.8dB）变成一坨噪音；修好后峰值 1.00；
- **BGM 缺失 id 超过 2 个就不猜**（如 `o2ma1228` 有 485 个 BGM id 缺失，硬映射只会把同一条样本反复重播）；
- 音符的 `hitSample` 只吃 ±1000 别名，绝不吃单主音频映射。

效果：`o2ma3510` / `o2ma3776` 两首原本完全没声音的曲子，现在都能产出完整音频（峰值 1.00）。

## BMS 模式（已接入）

BMS 与 OJN 在**语义层**几乎一一对应，只有**容器格式**完全不同，所以模式层各写一个解析器，输出链路全部共享：

| 概念 | BMS | O2Jam / OJN | 复用情况 |
|---|---|---|---|
| 容器 | 纯文本 `#WAV01` / `#00111:0011` | 300 字节二进制头 + 音符块 | 各写一个解析器（`modes/bms/bms.js` / `modes/o2jam/ojn.js`） |
| 一首歌 | 一个文件夹（每个 `.bms` 一个难度） | 一个 `.ojn`（内含 EX/NX/HX） | 各自的「歌曲模型」，外壳只认 `diffs` |
| 时间轴 | 小节 + 比例 + `#BPMxx`(03/08) + `#STOP`(09) + 小节长度(02) | measure + position + BPM_CHANGE / TIME_SIGNATURE | 各写一套（BMS 要处理 STOP 与小节长度） |
| 背景音 | 通道 `01` | `AUTO_PLAY` 通道 | ✓ 统一成 `audioObjects{autoplay}` |
| 键音 | 通道 `11-19/21-29` + `#WAVxx` | `NOTE_1..7` 携带 sampleId | ✓ 统一成物件的 `sampleId` |
| 长音 | 通道 `5x/6x`（`#LNTYPE`）+ `#LNOBJ` | type 2(HOLD) + type 3(RELEASE) | ✓ 未闭合一律补 1/2 拍（同一套修正口径） |
| 文本编码 | Shift-JIS（日系）/ GBK（国服改版）混存 | 二进制 + GBK | ✓ 共用 `core/text.js` 的打分器，各模式自己定候选顺序 |
| 输出侧 | — | — | ✓✓ **完全共享**：`core/osu/writer.js`、`keysound.js`、`audio.js` + `encoders/`、`zip.js` |

**BMS 的实测口径**（`npm test` 里锁死）：

- **时间轴**：`#BPMxx`（十六进制 03 / 索引 08）、`#STOP`（1/192 全音符）、小节长度 `02` —— 与人造探针的
  .NET 参考实现（BmsToOsu）**逐毫秒一致**（17/17 物件，含变速与 STOP）；
- **真谱面**：`In My Heart（全K音）` 467 个物件（7K）/ 613 个物件（7K1S），时间、列坐标、LN 结束全等；
- **键型**：5K / 5K1S / 7K / 7K1S / 10K / 10K2S / 14K / 14K2S 八种，列数 = 每排键数（+皿）× 排数；
  1P 块是 `[皿][1..7]`、2P 块是 `[1..7][皿]`，所以**左手皿落第 0 列、右手皿落最后一列**（与 .NET 参考实现的 lane 0..15 一致）；
- **列的取整**：`x = ⌊512·(列+0.5)/列数⌋`（7 列仍是 36/109/182/256/329/402/475）；
- **自动键型**：任一处用到 `18/19`（或 `28/29`）就按 7 键，否则 5 键；**按整首歌统一**（免得简单难度只弹前 5 列就把整组拽成 5K）；
  双人判定优先看 `#PLAYER 3`，并要求 2P 侧真有内容（≥3 个音符且不少于 1P 的四分之一）——
  实测 `847.Reverse MX` 写了 `#PLAYER 3` 但 2P 只有 8 个音符（1P 1600），按单人出图才对；
- **.osz 结构**：包内文件一律放在**根目录**，且条目不许重名 —— osu! 的
  `BeatmapImporter.createBeatmapDifficulties` 只认根层的 `.osu`（含 `/` 的直接跳过），
  而 `ZipArchiveReader.GetStream` 遇到重名条目会抛 `Sequence contains more than one matching element`
  （日志只显示 "Model creation failed"）。所以同名难度会自动补键型（`ANOTHER 14K2S` / `ANOTHER 7K1S`），
  `core/zip.js` 也会在打包时直接拒绝重名；
- **样本路径容错**：完整路径 → 同目录同名 → **同目录换扩展名**（BMS 写 `01.wav`、磁盘上只有 `01.ogg`；
  beatoraja / LR2 也这么找，实测 IIDX16 ~Empress~ 的 459 个样本全靠这一条才不静音）→ 全局同名/同主干唯一；
- **容错**：`#WAV` 真的找不到文件时**只静音、不丢音符**（BmsToOsu 的老毛病是整首变空谱）；
- **难度命名**：`#DIFFICULTY` → 标题/文件名**末尾**的 `[xxx]` → 文件名主干；
  一首歌里各难度的标题会取公共前缀（`"Space Boy [Hard]"` → `Space Boy`），
  难度写进 `Version:`，否则 osu! 会把三张谱拆成三张图。

还没做的（P1/P2）：`#LNTYPE 2` 的完整语义（当前按「5x 是结束标记」实现）、DP 14K 缺真实曲包实测（本机那份包全是单人谱）、
BGA → 视频/故事板、`#RANDOM` 的多重嵌套（支持但没实测大包）。

## 相对原版做的修正

1. **编码检测**：O2Jam 的 title/artist/noter 统一是 **GBK/CP936，连日文标题也是 GBK**。
   同一串字节 `d6f1 c8a1 ef77 cfe8` 只有 GB18030 能解出 `竹取飛翔`。原版用 Mozilla chardet，短串常猜成 ISO-8859-1 → 输出 `[¹ú·þ]¿¨Å©`（正确是 `[国服]卡农`）。
2. **混音偏移**：原版「整首只用到 1 个音频对象」时直接拷贝样本文件当音频（无前置静音），因此需要 `musicOffset = 该样本时间`；
   本工具的混音器永远渲染从 0 开始的完整时间轴，所以 `musicOffset` 必须为 **0**。搞错会让整张图提前——实测全库 **744/2995 个难度**受影响，平均提前 1893ms、最大 7031ms，而且小数偏移写出小数时间会让 osu! 直接拒绝导入。
3. **异常 Note 自动修正**（可关）：未闭合/零长/反向长条**一律补成 1/2 拍**（取长条那一刻的 BPM）；同列同刻重复音去重；长条中间夹音丢弃；负时间钳零；可选「超长长条阈值」。
4. **元数据**：`Creator:` 仍按原设定写 OJN 里的 noter；`Tags:` 可选「保留原版 / 追加 / 替换」，支持 `{noter} {songid} {server} {title} {artist} {diff} {level} {file}` 占位符。
5. **文本字段去尾空格**（OJN 是定长空格填充，原版会把 `"BeautifulDay  "` 原样写进 Title 和文件名）。

## 质量保障

```bash
npm test                  # 276 项：解析/编码/修正/混音/编码器/ZIP/界面接线/DOM/命令行/BMS 时间轴/本地 ffmpeg 接口/响度
npm run scan              # 量化偏移：按「实际能解析到几个音频对象」统计每首会被提前多少
npm run scan:keysound     # 保留键音模式：键音覆盖率/音轨选取/体积对比
npm run scan:audio        # 样本容器/可解性/音频能否盖住谱面
npm run scan:missing      # “音乐缺失”的真实情况（按 BGM 通道判定，不是“音符引用不到样本”）
npm run scan:mix          # 混音质量：峰值/削波、与「键音等效求和」的一致性（需系统 ffmpeg）
npm run scan:clip         # 过载信号的 MP3 编解码回归（需系统 ffmpeg）
npm run verify -- <目录>  # 验收整批 .osz：结构/CRC/AudioFilename/样本引用/音频盖不盖得住
npm run diag:ffmpegverify # 断言 ffmpeg 音频链路三条不变量（需系统 ffmpeg）
npm run diag:ffmpegapi    # 验证浏览器→本地 ffmpeg 这条路（需先 npm start）
npm run diag:bigpost      # 大请求体压力测试（需先 npm start）
npm run diag:loudness     # 输出响度 vs 原曲母带（需系统 ffmpeg）
npm run diag:ffmpeg       # 批量解码的分批调优探针
```

- 关掉修正后，`[TimingPoints]`/`[HitObjects]` 与原版 Java 输出**逐行一致**（用 `java -jar ../o2jam-to-osu.jar -i <ojn> -o %TEMP%\ojnverify --convert-all` 生成基线）。
- MP3 用 Node 与浏览器**同一份** `vendor/lamejs/lame.min.js`，测试会校验帧头（同步字/MPEG1/LayerIII/码率/采样率）与体积；
  实测与 ffmpeg libmp3lame@320 体积完全相同（3.96MB）、解码回来相关系数 0.99995 → 编码链路没写坏。
- 混音声像/归一化：`src/core/audio.js`（平衡式声像 + 峰值归一化到 -1dBFS），测试覆盖居中/全左/全右/半声像/音量/归一化开关。
- **音频引用不变量**（测试 17）：对每种音频模式（每难度/共享/MP3/键音/无 OJM）逐个验证 `.osu` 的 `AudioFilename` 指向的文件确实存在。
- **样本 id 兜底**（测试 18）：±1000 双向、精确优先、双区共存不建别名、单主音频长度阀值、
  BGM 大面积缺失不乱映射、单主音频只作用于 BGM、hitSample 不吃单主音频。
- 非标准采样率（MP3 不支持的）会显式报错，不会静默产出垃圾。
- **命令行输出验收**（`npm run verify -- <目录>`）：对整批 `.osz` 逐个检查 ZIP 结构/CRC、
  每个 `.osu` 的 `AudioFilename` 是否真的在包里（没有整首音轨时就查“引用的样本是否都在”）、
  长条结束时间合法（只有 `type & 128` 的长条第 6 字段才是结束时间，普通音符那里是 hitSample）、
  以及音频时长能不能盖住最后一个物件。实测 30 首/90 难度、鍵音与共享混音两种模式全过。

## 命令行是怎么用 ffmpeg 的

难点在于：浏览器的音频能力（`AudioContext.decodeAudioData`）在 Node 里没有，而转换逻辑全在 `src/`。
解法是**不换流程，只换两个边**：

1. **解码**：`src/core/audio.js` 的混音器现在会先看看 `audioCtx` 有没有 `decodeBatch()`。
   有（即命令行）就把“这首歌要用的所有样本”一次性交出去 → `tools/lib/ffmpeg.js` 开**一个** ffmpeg 进程，
   `-i` 摆一堆输入、`-map` 写出同样多个 f32le raw 文件，再读回来拆成声道。
   没有（即浏览器）就还是逐个 `decodeAudioData`——**浏览器代码一行没改**。
   - 实测 300 个样本：逐个 16450ms → 批量 2109ms（约 8×）。
   - 整批失败时会**逐条重试**（否则一个坏样本会连累整批），坏的记 null，与浏览器解码失败同语义。
   - 分批个数按**真实路径长度**算（Windows 命令行上限 ~32k 字符），固定个数在路径长时会直接 `ENAMETOOLONG`。
   - 同一内容跨曲目缓存（双层 FNV-1a 指纹 + LRU，默认 256MB）——不少歌共用同一套键音库。
2. **编码**：`src/encoders/index.js` 多了个后端注册表。命令行启动时把 mp3/ogg 注成 ffmpeg 实现，
   浏览器永远不注册，所以走的还是 lamejs。

还有两个不那么明显但必须处理的点：

- **样本真实格式要按内容嗅探**：OJM 里“`.wav` 其实是 MP3”、“M30 的 ogg 字段装的是 WAV”都很常见，
  扩展名只能当提示，写错会让 ffmpeg 白试一次（`sniffExt`）。
- **喂给 ffmpeg 的 PCM 缓冲必须拷贝**：`Buffer.from(arrayBuffer, …)` 是**视图**，流还没冲走就被下一轮覆写
  → 音频静默损坏。测试里那条“MP3 往返相关系数”就是专门盯这个的。

## 浏览器怎么也能用上 ffmpeg

网页里拿不到 ffmpeg，所以原本只能退而求其次用纯 JS 的 lamejs。但**本项目的页面本来就是 `npm start` 起的
Node 服务**，那就没必要为编码去下 32MB 的 ffmpeg.wasm —— 让那个服务去调系统 ffmpeg 就行。

- `GET /api/ffmpeg` → 是否可用、版本、编码器清单（页面加载时探一次，用于决定开关状态）
- `POST /api/encode?format=mp3&bitrate=320&rate=44100` ← 请求体是**左声道字节 ‖ 右声道字节**
  （不交织：省掉浏览器里几百万次逐样本赋值）→ 响应体是音频字节

浏览器侧 `src/encoders/ffmpeg-http.js` 把这两个接口接成编码后端（`registerEncoder`），
`ui.js` 在开始转换前根据开关注册/注销。探测不到接口就什么都不注册，于是自动走 lamejs。

实测（`npm run diag:ffmpegapi`）：4 分钟歌约 1.5 秒、最大 100MB 请求体也稳定，
解回来的左右声道与源信号相关系数 **1.00000**（证明两个声道没串、字节没传错）。

两个踩过的坑，都写成了回归测试：

- **参数校验必须在读完请求体之后做**。否则拒绝请求时连接里会剩下没读的数据，keep-alive 复用时
  污染下一个请求（实测表现为随机的 `ECONNRESET`，而浏览器的 POST 不会被自动重试）。
  即便如此，该接口仍然显式回 `Connection: close`。
- **`PORT=0` 要当“让系统分配端口”**，不能写 `Number(process.env.PORT) || 5173` —— `0` 是 falsy，
  会被悄悄换成 5173，于是测试去抢正在跑的开发服务器并报 `EADDRINUSE`。启动日志要打印**实际**绑定的端口。

如果哪天想让页面在**没有 Node**的情况下也快，再考虑 ffmpeg.wasm：`serve.js` 已经预留了 COOP/COEP 开关
（`CROSS_ORIGIN_ISOLATION=1`，多线程内核需要跨源隔离）。

## 性能：到底快了多少

同一首《Beautiful Day》（3 难度、104 秒音轨）：

| 路径 | 样本解码 | MP3 编码 | 单手合计 |
|---|---|---|---|
| 网页 + 本地 ffmpeg（默认，`npm start`） | 浏览器原生 `decodeAudioData` | **~0.6s**（libmp3lame） | **约 1.5s** |
| 网页 + 内置 lamejs（探测不到 ffmpeg 时） | 浏览器原生 `decodeAudioData` | ~20s（纯 JS） | ~20s |
| 命令行（`tools/cli.js`） | 300 个样本 / 批量 **2.2s**（ffmpeg） | **~0.9s** | **1.8s/首**（六路并行） |

1001 首整库：网页 + lamejs 约 6 小时 → 命令行 **约半小时**。

- 网页端瓶颈本来就是 lamejs。换成本地 ffmpeg 之后，**编码不再是瓶颈**，剩下的开销主要在解码与打包。
- 单靠给 lamejs 调参救不了：块大小 1152/11520/46080 之间中位数差异比轮间波动还小
  （多次测量甚至结论相反），码率 128k vs 320k 也落在噪声内 → 已回退 LAME 原生 1152。
  我们自己的 `float→int16` 只占 4ms/1000ms ≈ 0%。**瓶颈 100% 在 lamejs 的 JS 实现**。
- 历史教训：我先报过「块 11520 快 18%」「128k 快 1.6 倍」，多轮交错取中位数一测**两个都是噪声**
  （`npm run diag:mp3perf` 保留了这个基准）。

**万一确实在用 lamejs，页也不会卡**（`src/core/encoders/mp3.js: encodeMp3Async`）：编码切成时间片
（预算 12ms），每片后 `await` 让出主线程，批次大小自适应；同时把进度喂给界面。实测 12 秒音频切成
140 片、让出 139 次、**单片最长 26ms** → 编码全程页面可操作，进度条显示「编码中 x%」，
单曲超 800ms 会在日志里写清花了多久（避免误以为卡死）。

## 后续可加的功能（欢迎直接开工）

- **BMS P1**：`#LNTYPE 2` 完整语义（当前按「5x 是结束标记」实现）、DP(14K) 实战校验、
  BGA → 视频/故事板（`[Events]` 的 Sprite/Video 行）、`#RANDOM` 多重嵌套的大包实测；
- **BMS P2**：PMS 9K、bmson；
- **第三个模式**（例如 `iidx2bms`：产物是 BMS 而不是 `.osz`）—— 模式契约里的 `produces` 已经留好口子，
  外壳只负责「把产物变成文件」，打包是可选步骤；
- **把 O2Jam 的 pipeline 也搬到 `core/assemble.js`**：目前两个模式各自拼音频与 .osu 调用，
  逻辑一致但有两份；抽出公共装配器后新增模式会更薄；
- OGG/Opus 输出 —— ffmpeg 后端已支持 ogg（命令行 `--format ogg`）；opus 只需给 `FFMPEG_ENCODERS`
  加一行（注意 osu! stable 不认 opus，只有 lazer 认）；
- 浏览器里也开放 OGG 选项（`ffmpeg-http.js` 已经同时注册了 ogg，只差把 `nodeOnly` 标记去掉）；
- 命令行打成一个总 zip（而不是一首先一个 `.osz`）；
- Worker 里跑网页编码（只有退回 lamejs 时才有意义，能消掉最后一帧抖动）；
- `ffmpeg.wasm` 版（让页面在**没有 Node**时也快；代价 ~32MB 下载 + 需 COOP/COEP，`serve.js` 已预留开关）；
- 谱面预览（mini 版下落画面）；
- 导入现有 `.osu` 做反向对比；
