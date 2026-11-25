// 浮点 PCM → 16bit 整数：**必须先钳位再取整**。
//
// 血泪教训：直接写 `int16[i] = v * 32767` 时，Int16Array 的赋值是 **mod 65536 环绕**而不是饱和，
// 于是一个 +2.0 的采样点会变成 65534 → 存成 -2（符号翻转）。听感就是极刺耳的“兹拉兹拉”，
// 比普通削波（平顶）恶劣得多（实测：相关系数 0.264、66.7% 采样点符号翻转）。
// WAV 路径一直是钳位的，所以只有 MP3 会炸 —— 这也解释了“WAV 没事、MP3 有杂音”，
// 以及为何关掉峰值归一化后更明显：只有 |v| > 1 的采样点才会触发环绕。
//
// 公式沿用原 WAV 写法（钳位后 ×32767 再截断），这样 WAV 输出保持**逐字节不变**，
// MP3 只是把环绕换成饱和。
export function floatToInt16(f32, off = 0, n = f32.length, out){
  const dst = out || new Int16Array(n);          // 可传入复用的缓冲（编码循环里能省大量临时数组）
  const m = Math.min(n, dst.length);
  for(let i = 0; i < m; i++){
    const v = f32[off + i];
    const c = v < -1 ? -1 : (v > 1 ? 1 : v);      // 钳位（饱和）
    dst[i] = (c * 32767) | 0;                    // | 0 向零截断，且不会越界
  }
  return dst;
}

/** 统计超过 ±1 的采样点比例（用于提示“会削波”） */
export function countOutOfRange(f32){
  let over = 0, peak = 0;
  for(let i = 0; i < f32.length; i++){
    const v = Math.abs(f32[i]);
    if(v > peak) peak = v;
    if(v > 1) over++;
  }
  return { over, peak, ratio: f32.length ? over / f32.length : 0 };
}
