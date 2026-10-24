'use strict';

const fs = require('fs');
const path = require('path');

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatExtension(format) {
  if (format === 'jpeg') return 'jpg';
  if (format === 'webp') return 'webp';
  if (format === 'gif') return 'gif';
  return 'png';
}

/**
 * 按用户模板生成文件名，支持 {yyyy} {MM} {dd} {HH} {mm} {ss} {ms} 变量。
 * 非法字符会被替换为下划线。
 */
function buildBaseName(template, prefix) {
  const d = new Date();
  const tokens = {
    yyyy: String(d.getFullYear()),
    MM: pad2(d.getMonth() + 1),
    dd: pad2(d.getDate()),
    HH: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
    ss: pad2(d.getSeconds()),
    ms: String(d.getMilliseconds()).padStart(3, '0'),
  };
  const raw = String(template || 'screenshot_{yyyy}{MM}{dd}_{HH}{mm}{ss}');
  const replaced = raw.replace(/\{(yyyy|MM|dd|HH|mm|ss|ms)\}/g, (match, key) => tokens[key]);
  const safe = replaced.replace(/[\\/:*?"<>|]/g, '_').trim();
  const base = safe || `screenshot_${tokens.yyyy}${tokens.MM}${tokens.dd}`;
  return (prefix ? `${prefix}_${base}` : base).slice(0, 100);
}

function uniquePath(dir, base, extension) {
  let candidate = path.join(dir, `${base}.${extension}`);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}_${i}.${extension}`);
    i += 1;
  }
  return candidate;
}

function writeUnique(dir, base, extension, buffer) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = uniquePath(dir, base, extension);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = {
  pad2,
  formatExtension,
  buildBaseName,
  uniquePath,
  writeUnique,
};
