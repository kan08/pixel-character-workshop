import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, posix, sep } from 'node:path';
import { decodeGif, decodePng } from './image-codecs.mjs';
import { isObject, readJson, relativePath, requireThat } from './schema.mjs';

export async function artifactFile(jobDir, path) {
  const file = join(jobDir, relativePath(path, 'output'));
  const root = await realpath(join(jobDir, 'output'));
  requireThat(root === join(await realpath(jobDir), 'output') && (await lstat(file)).isFile() &&
    (await realpath(file)).startsWith(root + sep), '成果物は output/ 内の通常ファイルが必要: ' + path);
  return file;
}

function checkPng(path, png) {
  requireThat(png.hasTransparency && png.hasVisiblePixels, path + ' に透過画素と可視画素が必要');
  return png;
}

function hasInts(object, keys) {
  return isObject(object) && keys.every(key => Number.isSafeInteger(object[key]));
}

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function pathsForFrames(path, metadata) {
  requireThat(isObject(metadata) && typeof metadata.sheet === 'string' && Array.isArray(metadata.frames), '不正なフレーム JSON');
  const resolveFile = (name, extension) => {
    requireThat(typeof name === 'string' && name.endsWith(extension), '不正なフレーム対象ファイル');
    relativePath('output/' + name, 'output');
    return posix.join(dirname(path), name);
  };
  return {
    sheet: resolveFile(metadata.sheet, '.png'),
    frames: metadata.frames.map(frame => resolveFile(frame?.file, '.png')),
  };
}

async function verifySheet(metadata, path, pngs) {
  const paths = pathsForFrames(path, metadata);
  const sheet = await pngs.get(paths.sheet);
  requireThat(sheet && metadata.frames.length >= 2, 'シート PNG と複数コマが必要');
  requireThat(metadata.width === sheet.width && metadata.height === sheet.height, 'シートの寸法と JSON が一致しない');
  const used = [];
  for (const [index, frame] of metadata.frames.entries()) {
    const { rect, pivot, ms } = frame;
    requireThat(hasInts(rect, ['x', 'y', 'width', 'height']) && rect.x >= 0 && rect.y >= 0 &&
      rect.width > 0 && rect.height > 0 && rect.x + rect.width <= sheet.width &&
      rect.y + rect.height <= sheet.height, 'シート範囲外のコマ: ' + (index + 1));
    requireThat(!used.some(other => overlaps(other, rect)), 'シート上のコマが重複: ' + (index + 1));
    used.push(rect);
    requireThat(hasInts(pivot, ['x', 'y']) && pivot.x >= 0 && pivot.y >= 0 &&
      pivot.x <= rect.width && pivot.y <= rect.height, '不正な pivot: ' + (index + 1));
    requireThat(Number.isInteger(ms) && ms > 0 && ms <= 655350 && ms % 10 === 0, '不正な ms: ' + (index + 1));
    const png = await pngs.get(paths.frames[index]);
    requireThat(png?.width === rect.width && png.height === rect.height, 'コマ PNG の寸法が rect と一致しない: ' + (index + 1));
    for (let y = 0; y < rect.height; y++) {
      const begin = (sheet.width * (rect.y + y) + rect.x) * 4;
      requireThat(sheet.pixels.subarray(begin, begin + rect.width * 4)
        .equals(png.pixels.subarray(y * rect.width * 4, (y + 1) * rect.width * 4)), 'コマ PNG の画素がシートと一致しない: ' + (index + 1));
    }
  }
  return metadata.frames.length + ' コマの範囲・基準点・表示時間・画素を照合';
}

export async function inspectArtifacts({ jobDir, job, result }) {
  const checks = [];
  async function check(name, run, required = true) {
    try {
      const detail = await run();
      checks.push({ name, status: 'pass', required, detail });
    } catch (error) {
      checks.push({ name, status: 'fail', required, detail: error.message });
    }
  }
  const pngs = new Map();
  const gifs = new Map();
  let metadata;
  let metadataPath;
  await check('artifacts', async () => {
    requireThat(result.artifacts.length, '成果物がない');
    for (const path of result.artifacts) await artifactFile(jobDir, path);
    return result.artifacts.length + ' ファイル';
  });
  for (const path of result.artifacts.filter(path => path.endsWith('.png'))) {
    await check('png: ' + path, async () => {
      const png = checkPng(path, decodePng(await readFile(await artifactFile(jobDir, path))));
      pngs.set(path, png);
      return png.width + ' × ' + png.height + '、透過あり';
    });
  }
  if (job.kind !== 'animation') {
    await check('png-preview', () => {
      const preview = pngs.get(result.preview);
      requireThat(preview, '検品済みの PNG プレビューが必要');
      requireThat([...pngs.values()].some(png => preview.width > png.width && preview.height > png.height &&
        preview.width % png.width === 0 && preview.width * png.height === preview.height * png.width),
      '原寸 PNG と整数倍率の拡大 PNG が必要');
      return preview.width + ' × ' + preview.height;
    });
    return checks;
  }
  const json = result.artifacts.filter(path => path.endsWith('.json'));
  await check('sheet-json', async () => {
    requireThat(json.length === 1, 'フレーム JSON は1ファイル必要');
    metadataPath = json[0];
    metadata = await readJson(await artifactFile(jobDir, metadataPath));
    return verifySheet(metadata, metadataPath, pngs);
  });
  const gifPaths = result.artifacts.filter(path => path.endsWith('.gif'));
  await check('gif-preview', () => {
    requireThat(gifPaths.length === 2 && gifPaths.includes(result.preview), '原寸と拡大の GIF が1本ずつ必要');
    return gifPaths.length + ' 本';
  });
  for (const path of gifPaths) {
    await check('gif-decode: ' + path, async () => {
      const gif = decodeGif(await readFile(await artifactFile(jobDir, path)));
      gifs.set(path, gif);
      return gif.version + ' / ' + gif.width + ' × ' + gif.height;
    });
    await check('frame-count: ' + path, () => {
      const gif = gifs.get(path);
      requireThat(gif && gif.frames.length >= 2, 'アニメーション GIF は2コマ以上が必要');
      requireThat(Array.isArray(metadata?.frames) && gif.frames.length === metadata.frames.length, 'GIF と JSON のコマ数が一致しない');
      return gif.frames.length + ' コマ';
    });
    await check('gif-timing: ' + path, () => {
      const gif = gifs.get(path);
      requireThat(gif?.loopCount === 0, '無限ループ指定が必要');
      requireThat(gif.frames.every((frame, i) => frame.ms > 0 && frame.ms === metadata?.frames?.[i]?.ms),
        'GIF と JSON の表示時間が一致しない');
      return gif.frames.map(frame => frame.ms + ' ms').join(' / ');
    });
  }
  await check('gif-size', () => {
    const native = metadata?.frames?.[0]?.rect;
    const preview = gifs.get(result.preview);
    requireThat(native && preview && [...gifs.values()].some(gif => gif.width === native.width && gif.height === native.height) &&
      metadata.frames.every(frame => frame?.rect?.width === native.width && frame?.rect?.height === native.height),
      '原寸 GIF とコマ寸法が一致しない');
    requireThat(preview.width > native.width && preview.height > native.height && preview.width % native.width === 0 &&
      preview.width * native.height === preview.height * native.width, '拡大 GIF の倍率が不正');
    return preview.width + ' × ' + preview.height;
  });
  return checks;
}
