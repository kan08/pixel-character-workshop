import { deflateSync, inflateSync } from 'node:zlib';
import { requireThat } from './schema.mjs';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxPixels = 4_194_304;

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

export function encodePng(width, height, pixels) {
  const header = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 8, 6, 0, 0, 0]);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    pngSignature, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(left, above, corner) {
  const estimate = left + above - corner;
  const distances = [Math.abs(estimate - left), Math.abs(estimate - above), Math.abs(estimate - corner)];
  return [left, above, corner][distances.indexOf(Math.min(...distances))];
}

const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const channelsFor = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const adam7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

export function decodePng(bytes) {
  requireThat(bytes.length >= 33 && bytes.subarray(0, 8).equals(pngSignature), '不正な PNG シグネチャ');
  requireThat(bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR', 'PNG に IHDR がない');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const [depth, color, compression, filterMethod, interlace] = bytes.subarray(24, 29);
  requireThat(width > 0 && height > 0 && width * height <= maxPixels && depths[color]?.includes(depth) &&
    compression === 0 && filterMethod === 0 && interlace <= 1, '未対応の PNG 寸法・形式');
  let palette;
  let transparency;
  const data = [];
  let ended = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const end = offset + 12 + bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    requireThat(end <= bytes.length &&
      crc32(bytes.subarray(offset + 4, end - 4)) === bytes.readUInt32BE(end - 4), 'PNG チャンク破損');
    const chunk = bytes.subarray(offset + 8, end - 4);
    if (type === 'PLTE') palette = chunk;
    if (type === 'tRNS') transparency = chunk;
    if (type === 'IDAT') data.push(chunk);
    if (type === 'IEND') {
      ended = chunk.length === 0 && end === bytes.length;
      break;
    }
    offset = end;
  }
  requireThat(ended && data.length, 'PNG の IDAT または IEND がない');
  if (color === 3) {
    requireThat(palette?.length && palette.length <= 3 * (1 << depth) && palette.length % 3 === 0, '不正な PNG パレット');
  }
  if (transparency) {
    requireThat(
      (color === 0 && transparency.length === 2) || (color === 2 && transparency.length === 6) ||
      (color === 3 && transparency.length > 0 && transparency.length <= palette.length / 3), '不正な PNG tRNS',
    );
  }
  const channels = channelsFor[color];
  const groupBytes = Math.ceil(channels * depth / 8);
  const passes = (interlace ? adam7 : [[0, 0, 1, 1]]).map(([x, y, dx, dy]) => {
    const columns = Math.ceil((width - x) / dx);
    const rows = Math.ceil((height - y) / dy);
    return { x, y, dx, dy, columns, rows, stride: Math.ceil(columns * channels * depth / 8) };
  }).filter(pass => pass.columns > 0 && pass.rows > 0);
  const expected = passes.reduce((sum, pass) => sum + (pass.stride + 1) * pass.rows, 0);
  const raw = inflateSync(Buffer.concat(data), { maxOutputLength: expected });
  requireThat(raw.length === expected, 'PNG の走査線サイズが不正');

  const pixels = Buffer.alloc(width * height * 4);
  let offset = 0;
  const toByte = depth === 16 ? value => value >> 8 : value => Math.round(value * 255 / ((1 << depth) - 1));
  const transparentSamples = transparency && color !== 3
    ? Array.from({ length: channels }, (_, channel) => transparency.readUInt16BE(channel * 2))
    : null;
  let hasTransparency = false;
  let hasVisiblePixels = false;
  for (const pass of passes) {
    let previous = Buffer.alloc(pass.stride);
    for (let y = 0; y < pass.rows; y++) {
      const filter = raw[offset++];
      requireThat(filter <= 4, '不正な PNG フィルター');
      const row = raw.subarray(offset, offset + pass.stride);
      for (let i = 0; i < row.length; i++) {
        const left = row[i - groupBytes] ?? 0;
        const above = previous[i];
        const corner = previous[i - groupBytes] ?? 0;
        const prediction = [0, left, above, (left + above) >> 1, filter === 4 ? paeth(left, above, corner) : 0];
        row[i] += prediction[filter];
      }
      offset += row.length;
      previous = row;
      for (let x = 0; x < pass.columns; x++) {
        const samples = Array.from({ length: channels }, (_, channel) => {
          const bit = (x * channels + channel) * depth;
          if (depth === 16) return row.readUInt16BE(bit >> 3);
          return (row[bit >> 3] >> (8 - depth - bit % 8)) & ((1 << depth) - 1);
        });
        const [first, second, third, fourth] = samples;
        const index = ((pass.y + y * pass.dy) * width + pass.x + x * pass.dx) * 4;
        let alpha = transparentSamples?.every((sample, channel) => sample === samples[channel]) ? 0 : 255;
        if (color === 3) {
          requireThat(first * 3 < palette.length, 'PNG パレットの範囲外を参照');
          palette.copy(pixels, index, first * 3, first * 3 + 3);
          alpha = transparency?.[first] ?? 255;
        } else if (color === 0 || color === 4) {
          pixels.fill(toByte(first), index, index + 3);
          if (color === 4) alpha = toByte(second);
        } else {
          pixels[index] = toByte(first);
          pixels[index + 1] = toByte(second);
          pixels[index + 2] = toByte(third);
          if (color === 6) alpha = toByte(fourth);
        }
        pixels[index + 3] = alpha;
        hasTransparency ||= alpha < 255;
        hasVisiblePixels ||= alpha > 0;
      }
    }
  }
  return { width, height, pixels, hasTransparency, hasVisiblePixels };
}

function gifPixels(data, minimum, expected, paletteSize) {
  requireThat(minimum >= 2 && minimum <= 8, '不正な GIF LZW サイズ');
  const clear = 1 << minimum;
  const end = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);
  let width = minimum + 1;
  let next = end + 1;
  let previous = -1;
  let first = 0;
  let position = 0;
  let count = 0;
  while (position + width <= data.length * 8) {
    const offset = position >> 3;
    const bits = data[offset] | ((data[offset + 1] ?? 0) << 8) | ((data[offset + 2] ?? 0) << 16);
    const code = (bits >> (position % 8)) & ((1 << width) - 1);
    position += width;
    if (code === clear) {
      width = minimum + 1;
      next = end + 1;
      previous = -1;
      continue;
    }
    if (code === end) {
      requireThat(count === expected, 'GIF の復号画素数が寸法と一致しない');
      return;
    }
    requireThat(code < next || (code === next && previous !== -1), '不正な GIF LZW コード');
    let current = code;
    let size = 0;
    if (current === next) {
      stack[size++] = first;
      current = previous;
    }
    while (current >= clear) {
      stack[size++] = suffix[current];
      current = prefix[current];
    }
    first = current;
    stack[size++] = first;
    count += size;
    requireThat(count <= expected, 'GIF の復号画素数が寸法を超えた');
    while (size) requireThat(stack[--size] < paletteSize, 'GIF パレットの範囲外を参照');
    if (previous !== -1 && next < 4096) {
      prefix[next] = previous;
      suffix[next++] = first;
      if (next === 1 << width && width < 12) width++;
    }
    previous = code;
  }
  throw new Error('GIF の LZW 終端がない');
}

export function decodeGif(bytes) {
  const version = bytes.toString('ascii', 0, 6);
  requireThat(bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(version), '不正な GIF ヘッダ');
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  requireThat(width > 0 && height > 0 && width * height <= maxPixels, '未対応の GIF 寸法');
  let offset = 13;
  const take = length => {
    requireThat(offset + length <= bytes.length, 'GIF データが途中で終了');
    const data = bytes.subarray(offset, offset + length);
    offset += length;
    return data;
  };
  const readByte = () => take(1)[0];
  const palette = flags => {
    if (!(flags & 128)) return 0;
    const size = 1 << ((flags & 7) + 1);
    take(size * 3);
    return size;
  };
  const subBlocks = () => {
    const blocks = [];
    for (let size = readByte(); size; size = readByte()) blocks.push(take(size));
    return Buffer.concat(blocks);
  };
  const globalSize = palette(bytes[10]);
  const frames = [];
  let loopCount = null;
  let delay = 0;
  let transparency = null;
  let totalPixels = 0;
  while (offset < bytes.length) {
    const block = readByte();
    if (block === 0x3b) {
      requireThat(frames.length && offset === bytes.length, '不正な GIF 終端またはフレームなし');
      return { version, width, height, loopCount, frames };
    }
    if (block === 0x21) {
      const label = readByte();
      if (label === 0xf9) {
        requireThat(readByte() === 4, '不正な GIF GCE');
        const control = take(4);
        delay = control.readUInt16LE(1) * 10;
        transparency = control[0] & 1 ? control[3] : null;
        requireThat(readByte() === 0, '不正な GIF GCE 終端');
      } else {
        const extension = subBlocks();
        if (label === 0xff && ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(extension.toString('ascii', 0, 11)) &&
          extension.length >= 14 && extension[11] === 1) loopCount = extension.readUInt16LE(12);
        if (label === 1) {
          delay = 0;
          transparency = null;
        }
      }
      continue;
    }
    requireThat(block === 0x2c, '不正な GIF ブロック');
    const frame = take(9);
    const [x, y, frameWidth, frameHeight] = [0, 2, 4, 6].map(index => frame.readUInt16LE(index));
    totalPixels += frameWidth * frameHeight;
    requireThat(frameWidth && frameHeight && x + frameWidth <= width && y + frameHeight <= height &&
      totalPixels <= maxPixels * 8, '不正な GIF フレーム寸法または総画素数');
    const colors = palette(frame[8]) || globalSize;
    requireThat(colors && (transparency === null || transparency < colors), '不正な GIF パレット');
    const minimum = readByte();
    gifPixels(subBlocks(), minimum, frameWidth * frameHeight, colors);
    frames.push({ x, y, width: frameWidth, height: frameHeight, ms: delay });
    delay = 0;
    transparency = null;
  }
  throw new Error('GIF トレーラーがない');
}

function encodeLzw(pixels, minimum) {
  const clear = 1 << minimum;
  const end = clear + 1;
  let dictionary = new Map();
  let width = minimum + 1;
  let decoderNext = end + 1;
  let previous = false;
  let bits = 0;
  let pending = 0;
  const bytes = [];
  const emit = code => {
    bits |= code << pending;
    pending += width;
    while (pending >= 8) {
      bytes.push(bits & 255);
      bits >>>= 8;
      pending -= 8;
    }
    if (code === clear) {
      width = minimum + 1;
      decoderNext = end + 1;
      previous = false;
    } else {
      if (previous && decoderNext < 4096 && ++decoderNext === 1 << width && width < 12) width++;
      previous = true;
    }
  };
  emit(clear);
  let prefix = pixels[0];
  for (let index = 1; index < pixels.length; index++) {
    const pixel = pixels[index];
    const key = (prefix << 8) | pixel;
    const code = dictionary.get(key);
    if (code !== undefined) {
      prefix = code;
    } else {
      emit(prefix);
      const next = end + 1 + dictionary.size;
      if (next < 4096) dictionary.set(key, next);
      else {
        emit(clear);
        dictionary = new Map();
      }
      prefix = pixel;
    }
  }
  emit(prefix);
  emit(end);
  if (pending) bytes.push(bits);
  return Buffer.from(bytes);
}

export function encodeGif(width, height, palette, frames) {
  const depth = Math.max(2, Math.ceil(Math.log2(palette.length)));
  const header = Buffer.alloc(13);
  header.write('GIF89a');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0xf0 | (depth - 1);
  const table = Buffer.alloc((1 << depth) * 3);
  palette.forEach((color, index) => table.set(color, index * 3));
  const loop = Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0])]);
  const blocks = [header, table, loop];
  for (const { pixels, ms } of frames) {
    // Restore to the transparent background between poses.
    const control = Buffer.from([0x21, 0xf9, 4, 9, 0, 0, 0, 0]);
    control.writeUInt16LE(ms / 10, 4);
    const descriptor = Buffer.from([0x2c, 0, 0, 0, 0, 0, 0, 0, 0, 0, depth]);
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    blocks.push(control, descriptor);
    const compressed = encodeLzw(pixels, depth);
    for (let start = 0; start < compressed.length; start += 255) {
      const part = compressed.subarray(start, start + 255);
      blocks.push(Buffer.from([part.length]), part);
    }
    blocks.push(Buffer.from([0]));
  }
  return Buffer.concat([...blocks, Buffer.from([0x3b])]);
}

export function nearestNeighbor(pixels, width, height, scale, channels) {
  const enlarged = Buffer.alloc(width * height * scale * scale * channels);
  const rowBytes = width * scale * channels;
  for (let y = 0; y < height; y++) {
    const row = y * scale * rowBytes;
    for (let x = 0; x < width; x++) {
      const start = (y * width + x) * channels;
      enlarged.fill(pixels.subarray(start, start + channels), row + x * scale * channels, row + (x + 1) * scale * channels);
    }
    for (let repeat = 1; repeat < scale; repeat++) enlarged.copy(enlarged, row + repeat * rowBytes, row, row + rowBytes);
  }
  return enlarged;
}
