// 统一出口（barrel）：kernel + 各模式的公开 API 汇总，方便测试与外部引用。
// 目录约定：
//   src/core/       —— 与格式无关的 kernel（.osu 写出器、混音、编码器、ZIP、工具）
//   src/modes/xxx/  —— 每个来源一个目录（解析 + 中间表示 + 流水线 + 界面面板）
//   src/ui/shell.js —— 多模式外壳（tab、日志、进度、下载），唯一碰 DOM 的总入口
export * from './core/util.js';
export * from './core/text.js';
export * from './core/zip.js';
export * from './core/unzip.js';
export * from './core/sampledur.js';
export * from './core/audio.js';
export * from './core/keysound.js';
export * from './core/osu/writer.js';
export * from './core/encoders/index.js';
export * from './core/encoders/ffmpeg-http.js';

// O2Jam（.ojn/.ojm）—— 保持扁平导出，老调用方（工具脚本/测试）不用改
export * from './modes/o2jam/ojn.js';
export * from './modes/o2jam/ojm.js';
export * from './modes/o2jam/samples.js';
export * from './modes/o2jam/chart.js';
export * from './modes/o2jam/pipeline.js';

// BMS（.bms/.bme/.bml/.bmx）—— 用命名空间，避免与 O2Jam 的 buildChart 同名冲突
export * as bms from './modes/bms/index.js';
