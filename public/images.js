import { imageLimit } from './project.js';

const maxPngBytes = 8 * 1024 * 1024;

export function canvas(width, height) {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

function pngSize(buffer) {
  const data = new DataView(buffer);
  if (data.byteLength < 33 || data.getUint32(0) !== 0x89504e47
    || data.getUint32(4) !== 0x0d0a1a0a || data.getUint32(8) !== 13
    || data.getUint32(12) !== 0x49484452) throw new Error('PNG画像を選んでください。');
  const width = data.getUint32(16);
  const height = data.getUint32(20);
  if (width < 1 || height < 1 || width > imageLimit || height > imageLimit) {
    throw new Error(`1〜${imageLimit}pxのPNGを選んでください。`);
  }
  return { width, height };
}

async function decode(buffer) {
  const { width, height } = pngSize(buffer);
  const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/png' }));
  if (bitmap.width === width && bitmap.height === height) return bitmap;
  bitmap.close();
  throw new Error('PNGのヘッダーと表示サイズが一致しません。');
}

export async function readPng(file) {
  if (file.size > maxPngBytes) throw new Error('1枚あたり8MB以下のPNGを選んでください。');
  const bitmap = await decode(await file.arrayBuffer());
  const { width, height } = bitmap;
  const target = canvas(width, height);
  target.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return { name: file.name.slice(0, 240), width, height, url: target.toDataURL('image/png') };
}

const bitmapCache = new WeakMap();
export function bitmapFor(image) {
  if (!bitmapCache.has(image)) {
    bitmapCache.set(image, (async () => {
      const bytes = Uint8Array.from(atob(image.url.split(',')[1]), char => char.charCodeAt(0));
      if (bytes.length > maxPngBytes) throw new Error('保存画像が8MBを超えています。');
      const bitmap = await decode(bytes.buffer);
      if (bitmap.width === image.width && bitmap.height === image.height) return bitmap;
      bitmap.close();
      throw new Error('保存された画像の実寸が合いません。');
    })());
  }
  return bitmapCache.get(image);
}

async function pixels(image) {
  const bitmap = await bitmapFor(image);
  const context = canvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

const hexColor = (r, g, b) => '#' + [r, g, b].map(byte => byte.toString(16).padStart(2, '0')).join('');

export async function colorSet(image) {
  const data = await pixels(image);
  const colors = new Set();
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3]) colors.add(hexColor(data[index], data[index + 1], data[index + 2]));
    if (colors.size > 256) break;
  }
  return [...colors].sort();
}

export async function imageIssues(image, basis) {
  const palette = new Set(basis.palette);
  let semi = 0;
  let otherColor = 0;
  let visible = 0;
  const data = await pixels(image);
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (!alpha) continue;
    visible++;
    if (basis.binaryAlpha && alpha !== 255) semi++;
    if (palette.size && !palette.has(hexColor(data[index], data[index + 1], data[index + 2]))) otherColor++;
  }
  const issues = [];
  if (!visible) issues.push('全画素が透明です');
  if (semi) issues.push(`半透明が${semi}画素あります`);
  if (otherColor) issues.push(`パレット外の色が${otherColor}画素あります`);
  return issues;
}

export async function pixelDiff(before, after) {
  if (before.width !== after.width || before.height !== after.height) return null;
  const a = await pixels(before);
  const b = await pixels(after);
  let changed = 0;
  for (let index = 0; index < a.length; index += 4) {
    if (a[index] !== b[index] || a[index + 1] !== b[index + 1]
      || a[index + 2] !== b[index + 2] || a[index + 3] !== b[index + 3]) changed++;
  }
  return changed;
}

export function toPngBlob(element) {
  return new Promise((resolve, reject) => element.toBlob(
    blob => blob ? resolve(blob) : reject(new Error('PNGを生成できませんでした。')), 'image/png',
  ));
}
