export const motions = { idle: '待機', walk: '歩き' };
export const poses = {
  idle: '通常姿勢', 'right-contact': '右足前の接地',
  'left-contact': '左足前の接地', passing: '通過姿勢', other: '未指定',
};
export const frameLimit = 32;
export const imageLimit = 512;
export const minDuration = 20;
export const maxDuration = 5000;

const validMotion = motion => Object.hasOwn(motions, motion);
const validPose = pose => Object.hasOwn(poses, pose);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const validText = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;

export function newProject(name = '無題のキャラクター') {
  const createClip = () => ({ frames: [], revisions: [] });
  return {
    schema: 1,
    name,
    basisVersion: 1,
    basis: { imageId: null, width: 32, height: 32, x: 16, y: 29, direction: 'right', palette: [], binaryAlpha: true },
    images: {},
    clips: { idle: createClip(), walk: createClip() },
  };
}

export function validBasis(basis, images) {
  return basis && integer(basis.width, 1, imageLimit) && integer(basis.height, 1, imageLimit)
    && integer(basis.x, 0, basis.width - 1) && integer(basis.y, 0, basis.height - 1)
    && ['right', 'left'].includes(basis.direction) && typeof basis.binaryAlpha === 'boolean'
    && Array.isArray(basis.palette) && basis.palette.length <= 256
    && basis.palette.every(color => typeof color === 'string' && /^#[a-f\d]{6}$/.test(color))
    && new Set(basis.palette).size === basis.palette.length
    && (basis.imageId === null || (typeof basis.imageId === 'string' && Object.hasOwn(images, basis.imageId)
      && images[basis.imageId].width === basis.width && images[basis.imageId].height === basis.height));
}

export function setBasis(project, basis) {
  if (!validBasis(basis, project.images)) throw new Error('基準画の寸法、足元座標、パレットを確認してください。');
  if (JSON.stringify(project.basis) !== JSON.stringify(basis)) {
    project.basis = structuredClone(basis);
    project.basisVersion++;
  }
}

function validFrame(frame, images) {
  return frame && typeof frame.imageId === 'string' && Object.hasOwn(images, frame.imageId)
    && integer(frame.ms, minDuration, maxDuration) && validPose(frame.pose);
}

function validFrames(frames, images) {
  return Array.isArray(frames) && frames.length <= frameLimit && frames.every(frame => validFrame(frame, images));
}

function validClip(clip, project) {
  return clip && validFrames(clip.frames, project.images) && Array.isArray(clip.revisions)
    && clip.revisions.every((revision, index) => revision && revision.id === index + 1
      && integer(revision.basisVersion, 1, project.basisVersion)
      && (revision.basis === undefined || validBasis(revision.basis, project.images))
      && validFrames(revision.frames, project.images) && revision.frames.length > 0
      && typeof revision.note === 'string' && revision.note.length <= 500);
}

export function parseProject(text) {
  const project = JSON.parse(text);
  if (!project || project.schema !== 1 || !validText(project.name, 80)
    || !integer(project.basisVersion, 1, Number.MAX_SAFE_INTEGER)
    || !project.images || Array.isArray(project.images) || typeof project.images !== 'object'
    || Object.entries(project.images).some(([id, image]) => !/^[\w-]{1,80}$/.test(id)
      || !image || !validText(image.name, 240) || !integer(image.width, 1, imageLimit)
      || !integer(image.height, 1, imageLimit) || typeof image.url !== 'string'
      || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.url))
    || !validBasis(project.basis, project.images)
    || !Object.keys(motions).every(motion => validClip(project.clips?.[motion], project))) {
    throw new Error('対応していない形式か、画像・コマの参照が壊れています。');
  }
  return project;
}

export function clipIssues(project, motion, frames) {
  if (frames.length === 0) return [`${motions[motion]}のコマを取り込んでください。`];
  const { width, height } = project.basis;
  const issues = [];
  frames.forEach((frame, index) => {
    const image = project.images[frame.imageId];
    if (image.width !== width || image.height !== height) issues.push(`${index + 1}コマ目の寸法が基準画と異なります。`);
  });
  if (motion === 'walk') {
    for (const pose of ['right-contact', 'left-contact']) {
      if (!frames.some(frame => frame.pose === pose)) issues.push(`${poses[pose]}を指定してください。`);
    }
  }
  return issues;
}

export function adopt(project, motion, note) {
  if (!validMotion(motion) || typeof note !== 'string' || note.length > 500) throw new Error('採用情報が不正です。');
  const clip = project.clips[motion];
  if (!project.basis.imageId) throw new Error('先に基準画を取り込んでください。');
  if (!validFrames(clip.frames, project.images)) throw new Error('コマ設定を確認してください。');
  const issues = clipIssues(project, motion, clip.frames);
  if (issues.length) throw new Error(issues.join(' '));
  const last = clip.revisions.at(-1);
  if (last?.basisVersion === project.basisVersion && framesEqual(last.frames, clip.frames)) {
    throw new Error('現在の採用版と同じコマ構成です。');
  }
  clip.revisions.push({
    id: clip.revisions.length + 1, basisVersion: project.basisVersion, note: note.trim(),
    basis: structuredClone(project.basis), frames: structuredClone(clip.frames),
  });
}

export function framesEqual(left, right) {
  return left.length === right.length && left.every((frame, index) => {
    const other = right[index];
    return frame.imageId === other.imageId && frame.ms === other.ms && frame.pose === other.pose;
  });
}

export function restore(project, motion, id) {
  const clip = project.clips[motion];
  const version = clip.revisions.find(revision => revision.id === id);
  if (!version) throw new Error('選んだ版が見つかりません。');
  clip.frames = structuredClone(version.frames);
}

export function planExport(project) {
  if (!project.basis.imageId) throw new Error('基準画を取り込んでください。');
  const clips = Object.entries(project.clips).filter(([motion]) => validMotion(motion)).map(([motion, clip]) => {
    const revision = clip.revisions.at(-1);
    if (!revision || revision.basisVersion !== project.basisVersion || !framesEqual(revision.frames, clip.frames)) {
      throw new Error(`${motions[motion]}を比較・採用タブで採用してください。`);
    }
    const issues = clipIssues(project, motion, revision.frames);
    if (issues.length) throw new Error(issues.join(' '));
    return { motion, revision };
  });
  const { width, height, x, y, direction } = project.basis;
  const count = clips.reduce((total, { revision }) => total + revision.frames.length, 0);
  const columns = Math.min(8, count);
  const rows = Math.ceil(count / columns);
  let index = 0;
  const animations = Object.fromEntries(clips.map(({ motion, revision }) => [motion, {
    loop: true, revision: revision.id,
    frames: revision.frames.map(frame => {
      const rect = { x: index % columns * width, y: Math.floor(index / columns) * height, width, height };
      index++;
      return { ...frame, rect };
    }),
  }]));
  return { schema: 1, character: project.name, width: columns * width, height: rows * height,
    cell: { width, height }, pivot: { x, y }, direction, animations };
}
