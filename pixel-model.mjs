const model = process.env.PIXEL_OLLAMA_MODEL || 'lfm3-original:q4';
const validColor = color => typeof color === 'string' && /^#[\da-f]{6}$/.test(color);
const isInteger = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function validateInput(input) {
  const { width, height, cells, palette, instruction } = input ?? {};
  if (!isInteger(width, 1, 12) || !isInteger(height, 1, 12)
    || !Array.isArray(cells) || cells.length !== width * height
    || !Array.isArray(palette) || palette.length < 2 || palette.length > 256
    || !palette.every(validColor) || new Set(palette).size !== palette.length
    || !cells.every(color => color === null || validColor(color))
    || typeof instruction !== 'string' || !instruction.trim() || instruction.length > 300) {
    throw new Error('編集範囲、パレットと指示を確認してください。');
  }
  const editable = cells.flatMap((color, index) => color === null ? [] : [index]);
  if (!editable.length) throw new Error('編集範囲に不透明な画素がありません。');
  return { width, height, cells, palette, instruction: instruction.trim(), editable };
}

export function validateEdits(edits, input) {
  const { cells, palette, editable } = input;
  if (!Array.isArray(edits) || edits.length > Math.min(24, editable.length)) {
    throw new Error('モデルの提案が画素数の上限を超えています。範囲を絞って再試行してください。');
  }
  const seen = new Set();
  for (const edit of edits) {
    if (!editable.includes(edit?.cell) || !isInteger(edit?.color, 0, palette.length - 1) || seen.has(edit.cell)) {
      throw new Error('モデルが編集範囲やパレットの条件を外れました。範囲を絞って再試行してください。');
    }
    seen.add(edit.cell);
  }
  const changed = edits.filter(edit => cells[edit.cell] !== palette[edit.color]);
  if (!changed.length) throw new Error('モデルは変更できる色を提案しませんでした。指示や範囲を変えてください。');
  return changed;
}

export async function generateEdits(raw) {
  let input;
  try { input = validateInput(raw); } catch (error) { return { status: 400, error: error.message }; }
  const { width, height, editable, palette, cells, instruction } = input;
  const colorIndices = palette.map((_, index) => index);
  const format = {
    type: 'object', additionalProperties: false, required: ['edits'],
    properties: {
      edits: {
        type: 'array', maxItems: Math.min(24, editable.length),
        items: {
          type: 'object', additionalProperties: false, required: ['cell', 'color'],
          properties: { cell: { type: 'integer', enum: editable }, color: { type: 'integer', enum: colorIndices } },
        },
      },
    },
  };
  const grid = Array.from({length: height}, (_, y) => cells.slice(y * width, (y + 1) * width)
    .map((color, x) => `${y * width + x}=${color ?? 'transparent'}`).join(' ')).join('\n');
  try {
    const response = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45000),
      body: JSON.stringify({
        model, format, stream: false, options: { temperature: 0, num_predict: 360 },
        system: 'You edit pixel art by recoloring existing opaque pixels. Return only necessary edits. Use each cell at most once. A cell is the numbered pixel. A color is the integer palette index, not a hex value. Leave other pixels untouched.',
        prompt: `Palette index=hex: ${palette.map((value, index) => `${index}=${value}`).join(' ')}\nCell=original hex (rows):\n${grid}\nRequested edit: ${instruction}`,
      }),
    });
    if (response.status === 404) return { status: 503, error: `Ollamaにモデル「${model}」がありません。` };
    if (!response.ok) return { status: 502, error: 'Ollamaが生成に失敗しました。' };
    const output = await response.json();
    try {
      const edits = validateEdits(JSON.parse(output.response).edits, input);
      return { status: 200, model, edits };
    } catch (error) {
      return { status: 422, error: error instanceof SyntaxError ? 'モデルの応答を読めませんでした。範囲を絞って再試行してください。' : error.message };
    }
  } catch (error) {
    const message = error.name === 'TimeoutError' ? '生成が45秒でタイムアウトしました。' : 'ローカルのOllamaに接続できません。';
    return { status: 503, error: message };
  }
}
