// 外部解压器封装：.rar / .7z 没有可靠的纯 JS 解码器（RAR5 尤其复杂），
// 所以命令行版直接调系统里的 7-Zip / UnRAR，把内容解到**系统临时目录**再走原有流程。
//
// 为什么解到临时目录也能解决「需要管理员权限」：源压缩包只被**读**，
// 不需要在它旁边创建文件；写入发生在我们自己的临时目录里。
//
// 浏览器版没有子进程，.rar/.7z 会给出明确提示（用命令行或先解压）。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const WIN_CANDIDATES = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  'C:\\Program Files\\WinRAR\\UnRAR.exe',
  'C:\\Program Files (x86)\\WinRAR\\UnRAR.exe',
  'C:\\Program Files\\WinRAR\\Rar.exe',
];

function probe(bin){
  try { return fs.existsSync(bin) ? bin : null; } catch (e){ return null; }
}

/** 找一个能解 rar/7z 的可执行文件；先看环境变量，再看 PATH，最后看常见安装路径 */
export function findExtractor(){
  for (const env of ['SBC_7Z', 'SEVENZIP', 'SEVEN_ZIP']){
    const v = process.env[env];
    if (v && probe(v)) return { bin: v, kind: /unrar/i.test(v) ? 'unrar' : '7z' };
  }
  for (const name of ['7z', '7za', '7zz', 'unrar']){
    for (const dir of (process.env.PATH || '').split(path.delimiter)){
      if (!dir) continue;
      for (const ext of ['.exe', '']){
        const p = path.join(dir, name + ext);
        if (probe(p)) return { bin: p, kind: name === 'unrar' ? 'unrar' : '7z' };
      }
    }
  }
  for (const p of WIN_CANDIDATES){
    if (probe(p)) return { bin: p, kind: /unrar/i.test(p) ? 'unrar' : '7z' };
  }
  return null;
}

/**
 * 解压一个压缩包到 destDir。
 * 7z:   7z x -y -o<dest> -p -bso0 -bsp0 <file>   （-p 空密码 → 加密包不会卡在输入密码）
 * unrar: UnRAR x -y -o+ <file> <dest + '\\'>
 */
export function extractArchive(extractor, file, destDir){
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const { bin, kind } = extractor;
    const args = kind === 'unrar'
      ? ['x', '-y', '-o+', file, destDir + path.sep]
      : ['x', '-y', '-bso0', '-bsp0', '-p', '-o' + destDir, file];
    execFile(bin, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err){
        const detail = String(stderr || '').trim().split(/\r?\n/).slice(-3).join(' / ');
        return reject(new Error((err.message || '解压失败') + (detail ? '：' + detail : '')));
      }
      resolve({ bin, bytes: 0 });
    });
  });
}

/** 给用户看的解压器名字（日志/报错用） */
export function extractorLabel(ex){
  return ex ? path.basename(ex.bin) : '7-Zip / UnRAR';
}
