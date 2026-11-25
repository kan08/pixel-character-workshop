import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import { decodePng, encodeGif, encodePng, nearestNeighbor } from '../image-codecs.mjs';
import { readJson, relativePath, requireThat, writeJson } from '../schema.mjs';

const size = 32;
const scale = 8;
const colors = {
  ink: '283048', purple: '6354a4', violet: '967bd2', light: 'c9b0f5',
  skin: 'efb68c', cheek: 'c57f77', gold: 'f6cb70', blue: '599ba6', white: 'fff0ce',
};
const palette = [[0, 0, 0], ...Object.values(colors).map(color => Buffer.from(color, 'hex'))];
const rgba = Object.fromEntries(Object.entries(colors).map(([name, hex]) => [name, Buffer.from(hex + 'ff', 'hex')]));

const walk = [[2, false, 120], [1, false, 110], [-2, false, 120], [-1, false, 110]];
const idle = [[0, false, 620], [0, true, 100]];

// These poses use the original sample in public/sample.js as their pixel reference.
function drawSprite(step = 0, blink = false, highlight = false) {
  const pixels = Buffer.alloc(size * size * 4);
  const box = (color, x, y, width, height) => {
    for (let row = y; row < y + height; row++) {
      const start = (row * size + x) * 4;
      pixels.fill(rgba[color], start, start + width * 4);
    }
  };
  const bob = Math.abs(step) === 1 ? 1 : 0;
  const body = (color, x, y, w, h) => box(color, x, y - bob, w, h);
  const frontX = [9, 14, 17, 15, 21][step + 2];
  const backX = [21, 16, 13, 18, 9][step + 2];
  const backY = step === 1 ? 25 : 27;
  const frontY = step === -1 ? 25 : 27;
  box('ink', backX - 1, backY - 1, 6, 4);
  box('blue', backX, backY, 4, 2);
  box('ink', 13, 21 - bob, 10, 5);
  box('purple', 14, 22 - bob, 8, 4);
  box('ink', frontX - 1, frontY - 1, 7, 4);
  box('violet', frontX, frontY, 5, 2);
  box('light', frontX + 3, frontY, 2, 1);
  body('ink', 8, 16, 15, 8);
  body('purple', 9, 17, 13, 6);
  body('violet', 12, 16, 10, 6);
  body('blue', 8, 17, 4, 5);
  body('gold', 15, 18, 6, 2);
  const arm = step === 2 ? 11 : step === -2 ? 18 : 15;
  body('ink', arm, 19, 5, 5);
  body('violet', arm + 1, 19, 3, 3);
  body('skin', arm + 1, 22, 3, 1);
  if (highlight) body('white', arm + 1, 20, 1, 2);
  body('ink', 11, 5, 14, 11);
  body('ink', 13, 3, 10, 14);
  body('violet', 13, 5, 10, 4);
  body('light', 15, 4, 6, 2);
  body('purple', 12, 7, 3, 7);
  body('skin', 15, 8, 9, 7);
  body('skin', 22, 11, 4, 3);
  body('cheek', 16, 13, 3, 1);
  body('ink', 21, 10, 2, blink ? 1 : 2);
  body('gold', 12, 10, 2, 2);
  body('purple', 14, 15, 9, 1);
  return pixels;
}

function indices(pixels) {
  const indexed = Buffer.alloc(size * size);
  for (let pixel = 0; pixel < indexed.length; pixel++) {
    if (pixels[pixel * 4 + 3] === 0) continue;
    const rgb = pixels.subarray(pixel * 4, pixel * 4 + 3);
    const index = palette.findIndex((color, i) => i > 0 && rgb.every((byte, channel) => byte === color[channel]));
    requireThat(index > 0, 'ルウのサンプルパレット外の色');
    indexed[pixel] = index;
  }
  return indexed;
}

async function sourceFrames(jobDir, job) {
  if (!job.inputs.previousMetadata) return null;
  const metadata = await readJson(join(jobDir, job.inputs.previousMetadata));
  requireThat(['idle', 'walk'].includes(metadata.motion), 'サンプルの前版メタデータが必要');
  const frames = [];
  for (const frame of metadata.frames) {
    const file = relativePath(posix.join(dirname(job.inputs.previousMetadata), frame.file), 'input');
    const png = await readFile(join(jobDir, file));
    const { pixels, width, height } = decodePng(png);
    requireThat(width === size && height === size, '前版のコマ寸法が一致しない');
    frames.push({ ...frame, png, pixels });
  }
  return { motion: metadata.motion, frames };
}

function freshFrames(motion, standing) {
  return (motion === 'idle' ? idle : walk).map(([step, blink, ms]) => ({
    ms, pixels: motion === 'idle' && !blink ? standing : drawSprite(step, blink),
  }));
}

async function animate(jobDir, job, standing) {
  const previous = await sourceFrames(jobDir, job);
  const instruction = (job.change || job.request).normalize('NFKC');
  const requestedMotion = /待機|まばたき|瞬き|\bidle\b/i.test(instruction) ? 'idle'
    : /歩き|歩行|\bwalk\b/i.test(instruction) ? 'walk' : null;
  const motion = requestedMotion || previous?.motion || 'walk';
  const frames = previous?.motion === motion ? previous.frames : freshFrames(motion, standing);
  const slow = /遅く|ゆっくり|速すぎ|スロー|\bslower\b/i.test(instruction);
  const fast = /速く|早く|遅すぎ|\bfaster\b/i.test(instruction);
  const sleeve = /袖|ハイライト/i.test(instruction);
  const switchesMotion = previous && motion !== previous.motion;
  requireThat(!previous || switchesMotion || slow || fast || sleeve, 'このサンプルで扱える修正はテンポ・袖・歩き／待機');
  requireThat(!(slow && fast), 'テンポの指定が競合しています');
  if (slow || fast) {
    for (const frame of frames) frame.ms = Math.min(655350, Math.max(20, Math.round(frame.ms * (slow ? 1.5 : 0.65) / 10) * 10));
  }
  if (sleeve) {
    const index = Number(instruction.match(/(\d+)\s*(?:番目の)?コマ/)?.[1] ?? 1) - 1;
    requireThat(index >= 0 && index < frames.length, '袖を修正するコマ番号が範囲外');
    const [step, blink] = (motion === 'idle' ? idle : walk)[index];
    const existingHighlight = frames[index].pixels.includes(rgba.white);
    const highlight = /除|なし|消|取り|外/.test(instruction) ? false : /付け|足す|追加|入れ/.test(instruction) || !existingHighlight;
    // Only the selected pose changes. All other PNGs are copied byte for byte.
    frames[index] = { ms: frames[index].ms, pixels: drawSprite(step, blink, highlight) };
  }

  const artifacts = [];
  const write = async (file, bytes) => {
    await writeFile(join(jobDir, file), bytes);
    artifacts.push(file);
  };
  const sheet = Buffer.alloc(size * frames.length * size * 4);
  const metadata = { motion, sheet: 'frames.png', width: size * frames.length, height: size, frames: [] };
  const gifFrames = [];
  for (const [index, frame] of frames.entries()) {
    const path = 'output/frame-' + String(index + 1).padStart(2, '0') + '.png';
    const x = index * size;
    await write(path, frame.png ?? encodePng(size, size, frame.pixels));
    for (let y = 0; y < size; y++) {
      frame.pixels.copy(sheet, (y * metadata.width + x) * 4, y * size * 4, (y + 1) * size * 4);
    }
    metadata.frames.push({
      file: basename(path), rect: { x, y: 0, width: size, height: size }, pivot: { x: 16, y: 28 }, ms: frame.ms,
    });
    gifFrames.push({ pixels: indices(frame.pixels), ms: frame.ms });
  }

  await write('output/frames.png', encodePng(metadata.width, metadata.height, sheet));
  await writeJson(join(jobDir, 'output/frames.json'), metadata);
  artifacts.push('output/frames.json');
  await write('output/' + motion + '.gif', encodeGif(size, size, palette, gifFrames));
  const preview = 'output/' + motion + '-preview.gif';
  await write(preview, encodeGif(size * scale, size * scale, palette, gifFrames.map(frame => ({
    ...frame, pixels: nearestNeighbor(frame.pixels, size, size, scale, 1),
  }))));
  return { artifacts, preview };
}

export async function runEngine({ jobDir, job }) {
  const standing = drawSprite();
  if (job.inputs.reference) {
    const reference = decodePng(await readFile(join(jobDir, job.inputs.reference)));
    for (let i = 0; i < reference.pixels.length; i += 4) {
      if (!reference.pixels[i + 3]) reference.pixels.fill(0, i, i + 3);
    }
    requireThat(reference.width === size && reference.height === size && reference.pixels.equals(standing),
      'Phase 0 のサンプルエンジンにはルウの基準画を指定してください');
    reference.pixels.copy(standing);
  }
  let output;
  if (job.kind === 'animation') {
    output = await animate(jobDir, job, standing);
  } else {
    requireThat(job.baseRevision === null, 'サンプルの基準画は固定です。採用後に歩きまたは待機へ進めます');
    const native = 'output/base.png';
    const preview = 'output/base-preview.png';
    await writeFile(join(jobDir, native), encodePng(size, size, standing));
    await writeFile(join(jobDir, preview), encodePng(size * scale, size * scale, nearestNeighbor(standing, size, size, scale, 4)));
    output = { artifacts: [native, preview], preview };
  }
  return { jobId: job.jobId, revision: job.revision, ...output };
}
