import {
  detectEncodableFormats,
  formatExtension,
  formatLabel,
  type OutputFormat,
} from './lib/capabilities';
import { kindLabel } from './lib/detect';
import { describeExif, readGpsPosition } from './lib/exif';
import {
  applyNamePattern,
  dedupeNames,
  formatBytes,
  formatDuration,
  parseSize,
  percentChange,
  saveBlob,
} from './lib/format';
import { describeResize } from './lib/geometry';
import { DEFAULT_MODEL_ID, MODELS } from './lib/superres';
import { filterLabel, type UpscaleFilter, type UpscaleMode } from './lib/upscale';
import { subscribeNetStats } from './lib/netGuard';
import { buildZip, canStreamToDisk, streamZipToDisk } from './lib/zip';
import { Converter } from './state';
import type { CropRect, ItemOverride, QueueItem, ResizeMode, Tool, UpscaleEngine } from './types';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const dropzone = el<HTMLElement>('dropzone');
const dropzoneTitle = dropzone.querySelector<HTMLElement>('.dropzone__title')!;
const fileInput = el<HTMLInputElement>('file-input');
const appMain = el<HTMLElement>('app-main');
const unsupported = el<HTMLElement>('unsupported');
const unsupportedDetail = el<HTMLElement>('unsupported-detail');

const controls = el<HTMLElement>('controls');
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
const panels = Array.from(document.querySelectorAll<HTMLElement>('.panel'));

const qualityInput = el<HTMLInputElement>('quality');
const qualityValue = el<HTMLOutputElement>('quality-value');
const qualityHint = el<HTMLElement>('quality-hint');
const targetSizeInput = el<HTMLInputElement>('target-size');
const targetClearButton = el<HTMLButtonElement>('target-clear');
const targetHint = el<HTMLElement>('target-hint');

const resizeModeSelect = el<HTMLSelectElement>('resize-mode');
const resizeHint = el<HTMLElement>('resize-hint');
const resizeLongestField = el<HTMLElement>('resize-longest-field');
const resizeLongestSelect = el<HTMLSelectElement>('resize-longest');
const resizePercentField = el<HTMLElement>('resize-percent-field');
const resizePercentInput = el<HTMLInputElement>('resize-percent');
const resizePercentValue = el<HTMLOutputElement>('resize-percent-value');
const resizeExactField = el<HTMLElement>('resize-exact-field');
const resizeWidthInput = el<HTMLInputElement>('resize-width');
const resizeHeightInput = el<HTMLInputElement>('resize-height');
const resizeKeepAspect = el<HTMLInputElement>('resize-keep-aspect');

const upscaleModeSelect = el<HTMLSelectElement>('upscale-mode');
const upscaleHint = el<HTMLElement>('upscale-hint');
const upscaleScaleField = el<HTMLElement>('upscale-scale-field');
const upscaleScales = el<HTMLElement>('upscale-scales');
const upscaleLongestField = el<HTMLElement>('upscale-longest-field');
const upscaleLongestSelect = el<HTMLSelectElement>('upscale-longest');
const upscaleExactField = el<HTMLElement>('upscale-exact-field');
const upscaleWidthInput = el<HTMLInputElement>('upscale-width');
const upscaleHeightInput = el<HTMLInputElement>('upscale-height');
const upscaleKeepAspect = el<HTMLInputElement>('upscale-keep-aspect');
const upscaleEngineSelect = el<HTMLSelectElement>('upscale-engine');
const upscaleEngineHint = el<HTMLElement>('upscale-engine-hint');
const upscaleFilterField = el<HTMLElement>('upscale-filter-field');
const upscaleFilterSelect = el<HTMLSelectElement>('upscale-filter');
const upscaleTuningField = el<HTMLElement>('upscale-tuning-field');
const upscaleSharpenInput = el<HTMLInputElement>('upscale-sharpen');
const upscaleSharpenValue = el<HTMLOutputElement>('upscale-sharpen-value');
const upscaleDering = el<HTMLInputElement>('upscale-dering');
const upscaleAiPanel = el<HTMLElement>('upscale-ai-panel');
const upscaleAiStatus = el<HTMLElement>('upscale-ai-status');
const upscaleProgress = el<HTMLElement>('upscale-progress');
const upscaleProgressFill = el<HTMLElement>('upscale-progress-fill');
const upscaleRunButton = el<HTMLButtonElement>('upscale-run');
const upscaleCancelButton = el<HTMLButtonElement>('upscale-cancel');
const upscaleResetButton = el<HTMLButtonElement>('upscale-reset');

const cropRatios = el<HTMLElement>('crop-ratios');
const rotateLeftButton = el<HTMLButtonElement>('rotate-left');
const rotateRightButton = el<HTMLButtonElement>('rotate-right');
const flipButton = el<HTMLButtonElement>('flip-h');
const transformResetButton = el<HTMLButtonElement>('transform-reset');
const transformHint = el<HTMLElement>('transform-hint');

const formatSelect = el<HTMLSelectElement>('format');
const formatHint = el<HTMLElement>('format-hint');
const namePatternInput = el<HTMLInputElement>('name-pattern');
const keepExifInput = el<HTMLInputElement>('keep-exif');
const keepGpsInput = el<HTMLInputElement>('keep-gps');
const keepIccInput = el<HTMLInputElement>('keep-icc');
const keepXmpInput = el<HTMLInputElement>('keep-xmp');

const results = el<HTMLElement>('results');
const resultsTitle = el<HTMLElement>('results-title');
const resultsProgress = el<HTMLElement>('results-progress');
const grid = el<HTMLUListElement>('grid');
const cancelButton = el<HTMLButtonElement>('cancel');
const clearButton = el<HTMLButtonElement>('clear');

const actionbar = el<HTMLElement>('actionbar');
const actionbarSummary = el<HTMLElement>('actionbar-summary');
const downloadZipButton = el<HTMLButtonElement>('download-zip');
const downloadPdfButton = el<HTMLButtonElement>('download-pdf');

const modal = el<HTMLElement>('modal');
const modalTitle = el<HTMLElement>('modal-title');
const modalBody = el<HTMLElement>('modal-body');
const modalClose = el<HTMLButtonElement>('modal-close');

const toast = el<HTMLElement>('toast');
const liveRegion = el<HTMLElement>('live-region');
const netCounter = el<HTMLElement>('net-counter');

let toastTimer: number | undefined;
let availableFormats = new Set<OutputFormat>(['image/jpeg', 'image/png']);

/* ------------------------------------------------------------- primitives */

function showToast(message: string): void {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3600);
}

function announce(message: string): void {
  liveRegion.textContent = message;
}

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let lastFocused: HTMLElement | null = null;
let onModalClose: (() => void) | null = null;

function openModal(title: string, body: HTMLElement, onClose?: () => void): void {
  lastFocused = document.activeElement as HTMLElement | null;
  onModalClose = onClose ?? null;
  modalTitle.textContent = title;
  modalBody.replaceChildren(body);
  modal.hidden = false;
  modalClose.focus();
}

function closeModal(): void {
  modal.hidden = true;
  modalBody.replaceChildren();
  onModalClose?.();
  onModalClose = null;
  lastFocused?.focus();
}

modalClose.addEventListener('click', closeModal);
modal.querySelector('[data-close]')?.addEventListener('click', closeModal);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modal.hidden) closeModal();
});

/* ------------------------------------------------------------------ hints */

function qualityDescription(quality: number): string {
  if (quality >= 95) return 'Near-lossless. Expect large files.';
  if (quality >= 85) return 'Great for photos and web use.';
  if (quality >= 70) return 'Noticeably smaller, still clean.';
  if (quality >= 50) return 'Visible artifacts in fine detail.';
  return 'Heavy compression — small but soft.';
}

const FORMAT_NOTES: Record<OutputFormat, string> = {
  'image/jpeg': 'JPG is the safe universal choice. Keeps EXIF and colour profile.',
  'image/png': 'Lossless and larger. Keeps colour profile and EXIF, ignores quality.',
  'image/webp': 'Much smaller than JPG at the same quality. Metadata is not carried over.',
  'image/avif': 'Smallest files, slowest to encode. Metadata is not carried over.',
};

/* --------------------------------------------------------------- converter */

const converter = new Converter({
  onItemAdded: (item) => {
    createCard(item);
    syncChrome();
  },
  onItemChanged: (item) => updateCard(item),
  onItemRemoved: (item) => {
    cards.get(item.id)?.root.remove();
    cards.delete(item.id);
    syncChrome();
  },
  onQueueChanged: () => {
    syncChrome();
    syncUpscaleStatus();
  },
  onEnhanceProgress: (state) => {
    const running = state !== null;
    upscaleProgress.hidden = !running;
    upscaleCancelButton.hidden = !running;
    upscaleRunButton.disabled = running;

    if (state) {
      upscaleProgressFill.style.width = `${Math.round(state.fraction * 100)}%`;
      // Built as nodes, not markup — the label carries a filename, and
      // filenames are allowed to contain angle brackets.
      const of = state.total > 1 ? ` (${state.done + 1} of ${state.total})` : '';
      const strong = makeElement('strong', '', state.label);
      upscaleAiStatus.replaceChildren(strong, document.createTextNode(of));
    } else {
      syncUpscaleStatus();
    }
  },
});

/* ------------------------------------------------------------------- tabs */

function selectTool(tool: Tool): void {
  for (const tab of tabs) {
    const active = tab.dataset.tool === tool;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  for (const panel of panels) {
    const active = panel.dataset.panel === tool;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  }
  // Every other tool only changes which controls are shown, so assigning
  // directly is enough. Upscale is the exception — it changes the output — so
  // crossing into or out of it has to go through updateSettings and re-encode.
  const crossesUpscale = (converter.settings.tool === 'upscale') !== (tool === 'upscale');
  if (crossesUpscale) converter.updateSettings({ tool });
  else converter.settings.tool = tool;

  if (tool === 'upscale') syncUpscaleStatus();
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTool(tab.dataset.tool as Tool));
}

/* ------------------------------------------------------------------- cards */

interface CardRefs {
  root: HTMLLIElement;
  image: HTMLImageElement;
  badge: HTMLElement;
  name: HTMLElement;
  meta: HTMLElement;
  delta: HTMLElement;
  note: HTMLElement;
  download: HTMLButtonElement;
  crop: HTMLButtonElement;
  compare: HTMLButtonElement;
  details: HTMLButtonElement;
}

const cards = new Map<string, CardRefs>();

function createCard(item: QueueItem): void {
  const root = makeElement('li', 'card');

  const thumb = makeElement('div', 'card__thumb');
  const image = makeElement('img');
  image.alt = '';
  image.hidden = true;
  thumb.appendChild(image);

  const badge = makeElement('div', 'card__badge');
  badge.appendChild(makeElement('div', 'spinner'));
  thumb.appendChild(badge);

  const remove = makeElement('button', 'card__remove', '×');
  remove.type = 'button';
  remove.title = 'Remove';
  remove.setAttribute('aria-label', `Remove ${item.file.name}`);
  remove.addEventListener('click', () => converter.remove(item.id));
  thumb.appendChild(remove);

  const body = makeElement('div', 'card__body');
  const name = makeElement('p', 'card__name');
  const meta = makeElement('p', 'card__meta');
  const delta = makeElement('p', 'card__delta');
  const note = makeElement('p', 'card__note');

  const actions = makeElement('div', 'card__actions');
  const download = makeElement('button', 'btn btn--ghost btn--small', 'Download');
  download.type = 'button';
  download.disabled = true;
  download.addEventListener('click', () => {
    if (item.outBlob) saveBlob(item.outBlob, item.outName);
  });

  const makeIcon = (glyph: string, title: string, handler: () => void) => {
    const button = makeElement('button', 'iconbtn', glyph);
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', `${title} — ${item.file.name}`);
    button.disabled = true;
    button.addEventListener('click', handler);
    return button;
  };

  const crop = makeIcon('⛶', 'Crop this image', () => openCropEditor(item));
  const compare = makeIcon('◐', 'Compare with original', () => void openCompare(item));
  const details = makeIcon('i', 'Details and metadata', () => openDetails(item));

  actions.append(download, crop, compare, details);
  body.append(name, meta, delta, note, actions);
  root.append(thumb, body);
  grid.appendChild(root);

  cards.set(item.id, { root, image, badge, name, meta, delta, note, download, crop, compare, details });
  updateCard(item);
}

function updateCard(item: QueueItem): void {
  const refs = cards.get(item.id);
  if (!refs) return;

  if (item.thumbUrl && refs.image.src !== item.thumbUrl) {
    refs.image.src = item.thumbUrl;
    refs.image.hidden = false;
  }

  const broken = item.status === 'error' || item.status === 'cancelled';
  refs.root.classList.toggle('card--error', broken);
  refs.badge.hidden = !(item.status === 'decoding' || item.encoding);
  refs.name.textContent = broken ? item.file.name : item.outName;
  refs.name.title = refs.name.textContent ?? '';

  if (broken) {
    refs.meta.textContent = '';
    refs.delta.className = 'card__error';
    refs.delta.textContent = item.error ?? 'Conversion failed';
    refs.note.textContent = '';
    refs.download.disabled = true;
    refs.crop.disabled = true;
    refs.compare.disabled = true;
    refs.details.disabled = true;
    refs.download.textContent = item.status === 'cancelled' ? 'Cancelled' : 'Failed';
    return;
  }

  if (item.status === 'decoding' || item.status === 'queued') {
    refs.meta.textContent = item.status === 'queued' ? 'Waiting…' : 'Reading…';
    refs.delta.textContent = '';
    return;
  }

  if (item.outBlob) {
    const marks = [`${item.outWidth}×${item.outHeight}`];
    // Direction matters now that images can grow as well as shrink.
    if (item.outWidth > item.srcWidth || item.outHeight > item.srcHeight) marks.push('↑');
    else if (item.outWidth !== item.srcWidth || item.outHeight !== item.srcHeight) marks.push('↓');
    if (converter.isEnhanced(item)) marks.push('AI');
    if (item.crop) marks.push('✂');
    refs.meta.textContent = `${marks.join(' ')} · ${formatBytes(item.outSize)}`;
    refs.delta.className = 'card__delta';
    const change = percentChange(item.file.size, item.outSize);
    refs.delta.classList.toggle('is-larger', change.endsWith('larger'));
    refs.delta.textContent = change
      ? `${kindLabel(item.kind)} ${formatBytes(item.file.size)} → ${change}`
      : '';
    refs.note.textContent = item.notes.length > 0 ? item.notes[0] : '';
    refs.download.disabled = item.encoding;
    refs.download.textContent = item.encoding ? 'Updating…' : 'Download';
    refs.crop.disabled = false;
    refs.compare.disabled = item.encoding;
    refs.details.disabled = false;
  } else {
    refs.meta.textContent = 'Processing…';
    refs.delta.textContent = '';
    refs.download.disabled = true;
  }
}

/* -------------------------------------------------------------- crop editor */

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

function openCropEditor(item: QueueItem): void {
  if (!item.thumbUrl) return;

  const container = makeElement('div', 'cropper');
  container.appendChild(
    makeElement('p', 'modal__lede', 'Drag inside to move, or pull a corner to resize.'),
  );

  const stage = makeElement('div', 'cropper__stage');
  const image = makeElement('img', 'cropper__img');
  image.src = item.thumbUrl;
  image.alt = '';
  stage.appendChild(image);

  const shade = makeElement('div', 'cropper__shade');
  const rect = makeElement('div', 'cropper__rect');
  for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
    const handle = makeElement('span', `cropper__handle cropper__handle--${corner}`);
    handle.dataset.handle = corner;
    rect.appendChild(handle);
  }
  stage.append(shade, rect);
  container.appendChild(stage);

  const readout = makeElement('p', 'cropper__readout');
  container.appendChild(readout);

  let crop: CropRect = item.crop ?? { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

  const paint = () => {
    rect.style.left = `${crop.x * 100}%`;
    rect.style.top = `${crop.y * 100}%`;
    rect.style.width = `${crop.width * 100}%`;
    rect.style.height = `${crop.height * 100}%`;
    const px = Math.round(crop.width * item.srcWidth);
    const py = Math.round(crop.height * item.srcHeight);
    readout.textContent = `${px} × ${py} px — ${Math.round(crop.width * 100)}% × ${Math.round(crop.height * 100)}% of the original`;
  };
  paint();

  let active: Handle | null = null;
  let startX = 0;
  let startY = 0;
  let startCrop = crop;

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

  stage.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    const handle = target.dataset.handle as Handle | undefined;
    if (!handle && target !== rect) return;
    active = handle ?? 'move';
    startX = event.clientX;
    startY = event.clientY;
    startCrop = { ...crop };
    stage.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  stage.addEventListener('pointermove', (event) => {
    if (!active) return;
    const bounds = stage.getBoundingClientRect();
    const dx = (event.clientX - startX) / bounds.width;
    const dy = (event.clientY - startY) / bounds.height;
    const MIN = 0.05;

    if (active === 'move') {
      crop = {
        ...startCrop,
        x: clamp(startCrop.x + dx, 0, 1 - startCrop.width),
        y: clamp(startCrop.y + dy, 0, 1 - startCrop.height),
      };
    } else {
      let { x, y, width, height } = startCrop;
      if (active === 'nw' || active === 'sw') {
        const nx = clamp(startCrop.x + dx, 0, startCrop.x + startCrop.width - MIN);
        width = startCrop.x + startCrop.width - nx;
        x = nx;
      } else {
        width = clamp(startCrop.width + dx, MIN, 1 - startCrop.x);
      }
      if (active === 'nw' || active === 'ne') {
        const ny = clamp(startCrop.y + dy, 0, startCrop.y + startCrop.height - MIN);
        height = startCrop.y + startCrop.height - ny;
        y = ny;
      } else {
        height = clamp(startCrop.height + dy, MIN, 1 - startCrop.y);
      }
      crop = { x, y, width, height };
    }
    paint();
  });

  const release = () => {
    active = null;
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);

  const buttons = makeElement('div', 'cropper__buttons');
  const apply = makeElement('button', 'btn btn--primary', 'Apply crop');
  apply.type = 'button';
  apply.addEventListener('click', () => {
    converter.setCrop(item.id, crop);
    closeModal();
    showToast('Crop applied');
  });

  const clear = makeElement('button', 'btn btn--ghost', 'Remove crop');
  clear.type = 'button';
  clear.addEventListener('click', () => {
    converter.setCrop(item.id, null);
    closeModal();
  });

  buttons.append(apply, clear);
  container.appendChild(buttons);

  openModal(`Crop — ${item.file.name}`, container);
}

/** Centres a crop of the given aspect ratio inside every queued image. */
function applyRatioToAll(ratio: number | null): void {
  const items = converter.items.filter((item) => item.status === 'ready');
  if (items.length === 0) return;

  for (const item of items) {
    if (ratio === null) {
      converter.setCrop(item.id, null);
      continue;
    }
    const sourceRatio = item.srcWidth / item.srcHeight;
    let width = 1;
    let height = 1;
    if (sourceRatio > ratio) width = ratio / sourceRatio;
    else height = sourceRatio / ratio;

    converter.setCrop(item.id, {
      x: (1 - width) / 2,
      y: (1 - height) / 2,
      width,
      height,
    });
  }
  showToast(ratio === null ? 'Crops removed' : `Cropped ${items.length} image${items.length === 1 ? '' : 's'}`);
}

/* -------------------------------------------------------------- modals */

async function openCompare(item: QueueItem): Promise<void> {
  if (!item.outBlob) return;

  const container = makeElement('div', 'compare');
  container.appendChild(
    makeElement('p', 'modal__lede', 'Drag the divider to compare the original against the result.'),
  );

  const stage = makeElement('div', 'compare__stage');
  const loading = makeElement('p', 'compare__loading', 'Rendering the original…');
  stage.appendChild(loading);
  container.appendChild(stage);

  const stats = makeElement('p', 'compare__stats');
  stats.textContent = `Original ${formatBytes(item.file.size)} · Result ${formatBytes(item.outSize)} · quality ${Math.round(item.qualityUsed * 100)}`;
  container.appendChild(stats);

  let originalUrl: string | null = null;
  let outputUrl: string | null = null;
  openModal(item.outName, container, () => {
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    if (outputUrl) URL.revokeObjectURL(outputUrl);
  });

  try {
    originalUrl = await converter.renderSourcePreview(item.id);
  } catch {
    loading.textContent = 'Could not render the original for comparison.';
    return;
  }

  outputUrl = URL.createObjectURL(item.outBlob);
  const before = makeElement('img', 'compare__img compare__img--before');
  before.src = originalUrl;
  before.alt = 'Original';
  const afterWrap = makeElement('div', 'compare__after');
  const after = makeElement('img', 'compare__img');
  after.src = outputUrl;
  after.alt = 'Result';
  afterWrap.appendChild(after);

  const handle = makeElement('div', 'compare__handle');
  const labelBefore = makeElement('span', 'compare__tag compare__tag--left', 'Original');
  const labelAfter = makeElement('span', 'compare__tag compare__tag--right', 'Result');

  stage.replaceChildren(before, afterWrap, handle, labelBefore, labelAfter);

  const setPosition = (value: number) => {
    const clamped = Math.max(0, Math.min(1, value));
    afterWrap.style.width = `${clamped * 100}%`;
    handle.style.left = `${clamped * 100}%`;
  };
  setPosition(0.5);

  const onPointer = (event: PointerEvent) => {
    const bounds = stage.getBoundingClientRect();
    setPosition((event.clientX - bounds.left) / bounds.width);
  };
  stage.addEventListener('pointerdown', (event) => {
    stage.setPointerCapture(event.pointerId);
    onPointer(event);
  });
  stage.addEventListener('pointermove', (event) => {
    if (event.buttons > 0) onPointer(event);
  });
}

function openDetails(item: QueueItem): void {
  const container = makeElement('div', 'details');

  const overrideSection = makeElement('section', 'details__section');
  overrideSection.appendChild(makeElement('h3', undefined, 'This file only'));

  const usingOverride = item.override !== null;
  const overrideToggle = makeElement('label', 'switch');
  const overrideCheck = makeElement('input');
  overrideCheck.type = 'checkbox';
  overrideCheck.checked = usingOverride;
  const track = makeElement('span', 'switch__track');
  track.appendChild(makeElement('span', 'switch__thumb'));
  overrideToggle.append(overrideCheck, track, makeElement('span', 'switch__label', 'Override the global settings'));
  overrideSection.appendChild(overrideToggle);

  const overrideFields = makeElement('div', 'details__fields');

  const qualityField = makeElement('label', 'details__field');
  qualityField.appendChild(makeElement('span', undefined, 'Quality'));
  const qualityRange = makeElement('input');
  qualityRange.type = 'range';
  qualityRange.min = '30';
  qualityRange.max = '100';
  qualityRange.value = String(Math.round((item.override?.quality ?? converter.settings.quality) * 100));
  qualityField.appendChild(qualityRange);

  const sizeField = makeElement('label', 'details__field');
  sizeField.appendChild(makeElement('span', undefined, 'Target size'));
  const sizeInput = makeElement('input');
  sizeInput.type = 'text';
  sizeInput.placeholder = 'e.g. 300kb';
  const currentTarget = item.override?.targetBytes ?? 0;
  sizeInput.value = currentTarget > 0 ? `${Math.round(currentTarget / 1024)}kb` : '';
  sizeField.appendChild(sizeInput);

  overrideFields.append(qualityField, sizeField);
  overrideSection.appendChild(overrideFields);
  overrideFields.hidden = !usingOverride;

  const commitOverride = () => {
    if (!overrideCheck.checked) {
      converter.setOverride(item.id, null);
      return;
    }
    const override: ItemOverride = {
      quality: Number(qualityRange.value) / 100,
      targetBytes: parseSize(sizeInput.value),
    };
    converter.setOverride(item.id, override);
  };

  overrideCheck.addEventListener('change', () => {
    overrideFields.hidden = !overrideCheck.checked;
    commitOverride();
  });
  qualityRange.addEventListener('change', commitOverride);
  sizeInput.addEventListener('change', commitOverride);

  container.appendChild(overrideSection);

  const sourceSection = makeElement('section', 'details__section');
  sourceSection.appendChild(makeElement('h3', undefined, 'Source'));
  sourceSection.appendChild(
    makeElement(
      'p',
      'details__extras',
      `${kindLabel(item.kind)} · ${item.srcWidth}×${item.srcHeight} · ${formatBytes(item.file.size)}`,
    ),
  );
  container.appendChild(sourceSection);

  const metaSection = makeElement('section', 'details__section');
  metaSection.appendChild(makeElement('h3', undefined, 'Metadata'));

  const exif = item.metadata.exif;
  if (!exif) {
    metaSection.appendChild(makeElement('p', 'details__empty', 'This file carries no EXIF metadata.'));
  } else {
    const gps = readGpsPosition(exif);
    if (gps) {
      const warning = makeElement('p', 'details__warning');
      warning.append(
        makeElement('strong', undefined, 'This photo knows where it was taken. '),
        document.createTextNode(
          `${gps.latitude.toFixed(5)}, ${gps.longitude.toFixed(5)} — remove the GPS rows below, or switch Location off under Convert, before sharing it publicly.`,
        ),
      );
      metaSection.appendChild(warning);
    }

    const table = makeElement('table', 'metatable');
    const tbody = makeElement('tbody');

    for (const field of describeExif(exif)) {
      const key = `${field.ifd}:${field.tag}`;
      const row = makeElement('tr');
      if (item.strippedKeys.has(key)) row.classList.add('is-stripped');

      const labelCell = makeElement('td', 'metatable__label');
      labelCell.append(
        makeElement('span', undefined, field.label),
        makeElement('span', 'metatable__ifd', field.ifd),
      );

      const valueCell = makeElement('td', 'metatable__value', field.display);
      const actionCell = makeElement('td', 'metatable__action');
      const strip = makeElement('button', 'linkbutton');
      strip.type = 'button';
      strip.textContent = item.strippedKeys.has(key) ? 'Restore' : 'Remove';
      strip.addEventListener('click', () => {
        const next = new Set(item.strippedKeys);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        converter.setStrippedKeys(item.id, next);
        row.classList.toggle('is-stripped', next.has(key));
        strip.textContent = next.has(key) ? 'Restore' : 'Remove';
      });
      actionCell.appendChild(strip);

      row.append(labelCell, valueCell, actionCell);
      tbody.appendChild(row);
    }

    table.appendChild(tbody);
    metaSection.appendChild(table);
  }

  const extras: string[] = [];
  if (item.metadata.icc) extras.push(`ICC colour profile (${formatBytes(item.metadata.icc.length)})`);
  if (item.metadata.xmp) extras.push(`XMP packet (${formatBytes(item.metadata.xmp.length)})`);
  if (extras.length > 0) {
    metaSection.appendChild(makeElement('p', 'details__extras', `Also present: ${extras.join(' · ')}`));
  }

  container.appendChild(metaSection);

  if (item.notes.length > 0) {
    const notesSection = makeElement('section', 'details__section');
    notesSection.appendChild(makeElement('h3', undefined, 'Notes'));
    const list = makeElement('ul', 'details__notes');
    for (const note of item.notes) list.appendChild(makeElement('li', undefined, note));
    notesSection.appendChild(list);
    container.appendChild(notesSection);
  }

  openModal(item.outName, container);
}

function openTrustPanel(): void {
  const container = makeElement('div', 'prose');
  container.innerHTML = `
    <p>This page processes your images using WebAssembly and your browser's own
       encoders, inside your own tab. There is no server to upload to. Here is how to
       confirm that rather than take our word:</p>
    <ol>
      <li><strong>Turn off your wifi</strong>, then convert a photo. It still works — because
          nothing is being sent or fetched.</li>
      <li><strong>Open DevTools → Network</strong>, convert a photo and watch. You will see the
          page's own files load once, and nothing after that.</li>
      <li><strong>Watch the counter</strong> in the header. It tallies every byte this page sends
          through fetch, XHR, beacons and WebSockets. It stays at zero.</li>
      <li><strong>Read the source.</strong> The project is open source, so the code running here
          is the code you can inspect.</li>
    </ol>
    <h3>What this page does not do</h3>
    <ul>
      <li>No analytics, no tracking pixels, no third-party scripts.</li>
      <li>No cookies and no local storage of your images.</li>
      <li>No accounts, and no file history.</li>
      <li>A Content-Security-Policy restricts connections to this origin only.</li>
    </ul>
    <p class="prose__note">The byte counter is instrumentation, not a security control — it
       reports what this page's own code does. The CSP and your network panel are the
       independent checks.</p>
  `;
  openModal('Verify the privacy claim', container);
}

function openAboutPanel(): void {
  const container = makeElement('div', 'prose');
  container.innerHTML = `
    <p>A browser-based image toolkit: compress, resize, crop, rotate and convert.
       HEIC decoding is done by <strong>libheif</strong> compiled to WebAssembly;
       everything else uses your browser's own image decoders and encoders.</p>
    <h3>Licences</h3>
    <p><strong>libheif</strong> — LGPL-2.1-or-later.
       Source: <code>https://github.com/strukturag/libheif</code>.
       It is used here as an unmodified compiled library, and you are free to obtain,
       modify and relink it under the terms of the LGPL.</p>
    <p><strong>libde265</strong> (HEVC decoding, bundled inside the libheif build) — LGPL-3.0.</p>
    <p><strong>fflate</strong> — MIT, used for ZIP writing and PNG chunk compression.</p>
    <h3>Formats</h3>
    <p>Reads HEIC, HEIF, AVIF, JPG, PNG, WebP, GIF and BMP. Writes JPG, PNG, WebP and
       AVIF where your browser supports them, plus PDF.</p>
    <p class="prose__note">EXIF, ICC colour profiles and XMP are carried into JPG and PNG.
       WebP and AVIF output does not carry metadata.</p>
  `;
  openModal('About & licences', container);
}

/* ------------------------------------------------------------ page chrome */

function syncChrome(): void {
  const { total, ready, failed, busy, etaMs } = converter.progress;
  const hasItems = total > 0;

  controls.hidden = !hasItems;
  results.hidden = !hasItems;
  actionbar.hidden = !hasItems;

  document.body.classList.toggle('has-files', hasItems);
  dropzone.classList.toggle('is-compact', hasItems);
  dropzoneTitle.textContent = hasItems ? 'Add more images' : 'Drop images here';

  if (!hasItems) return;

  const parts = [`${ready} of ${total} ready`];
  if (failed > 0) parts.push(`${failed} failed`);
  resultsTitle.textContent = `Processed · ${parts.join(' · ')}`;

  cancelButton.hidden = !busy;

  if (busy) {
    const done = ready + failed;
    const eta = etaMs ? ` · about ${formatDuration(etaMs)} left` : '';
    resultsProgress.textContent = `Working on ${done + 1} of ${total}${eta}`;
  } else {
    resultsProgress.textContent = `${formatBytes(converter.totalOutputSize)} total`;
  }

  actionbarSummary.replaceChildren(
    makeElement('strong', undefined, `${ready} file${ready === 1 ? '' : 's'}`),
    document.createTextNode(
      busy ? ' ready · still working…' : ` ready · ${formatBytes(converter.totalOutputSize)} total`,
    ),
  );

  const canDownload = ready > 0 && !busy;
  downloadZipButton.disabled = !canDownload;
  downloadPdfButton.disabled = !canDownload;
  downloadZipButton.textContent = ready === 1 ? 'Download file' : `Download all as ZIP (${ready})`;
}

/* ---------------------------------------------------------- input wiring */

function acceptFiles(fileList: FileList | null): void {
  if (!fileList || fileList.length === 0) return;
  const files = Array.from(fileList);
  converter.addFiles(files);
  announce(`${files.length} file${files.length === 1 ? '' : 's'} added.`);
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener('change', () => {
  acceptFiles(fileInput.files);
  fileInput.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth++;
  dropzone.classList.add('is-dragging');
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropzone.classList.remove('is-dragging');
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('is-dragging');
  acceptFiles(event.dataTransfer?.files ?? null);
});

/* --------- compress --------- */

qualityInput.addEventListener('input', () => {
  const quality = Number(qualityInput.value);
  qualityValue.textContent = String(quality);
  qualityHint.textContent = qualityDescription(quality);
});
qualityInput.addEventListener('change', () =>
  converter.updateSettings({ quality: Number(qualityInput.value) / 100 }),
);

function commitTargetSize(): void {
  const bytes = parseSize(targetSizeInput.value);
  if (targetSizeInput.value.trim() && bytes === 0) {
    targetHint.textContent = "Couldn't read that — try something like 500kb or 2mb.";
    return;
  }
  targetHint.textContent = bytes
    ? `Every file will be squeezed under ${formatBytes(bytes)}.`
    : 'Got an upload limit? Type the number and every file lands under it.';
  converter.updateSettings({ targetBytes: bytes });
}
targetSizeInput.addEventListener('change', commitTargetSize);
targetClearButton.addEventListener('click', () => {
  targetSizeInput.value = '';
  commitTargetSize();
});

/* --------- resize --------- */

function commitResize(): void {
  const mode = resizeModeSelect.value as ResizeMode;
  resizeLongestField.hidden = mode !== 'longest';
  resizePercentField.hidden = mode !== 'percent';
  resizeExactField.hidden = mode !== 'exact';

  const resize = {
    mode,
    longest: Number(resizeLongestSelect.value),
    width: Math.max(1, Number(resizeWidthInput.value) || 1),
    height: Math.max(1, Number(resizeHeightInput.value) || 1),
    keepAspect: resizeKeepAspect.checked,
    percent: Number(resizePercentInput.value),
  };
  resizeHint.textContent =
    mode === 'none' ? 'Images keep their current size.' : describeResize(resize);
  converter.updateSettings({ resize });
}

resizeModeSelect.addEventListener('change', commitResize);

/* --------- upscale --------- */

for (const filter of ['catrom', 'lanczos3', 'lanczos2', 'mitchell', 'bilinear'] as UpscaleFilter[]) {
  const option = makeElement('option', '', filterLabel(filter));
  option.value = filter;
  if (filter === 'catrom') option.selected = true;
  upscaleFilterSelect.appendChild(option);
}

function selectedScale(): number {
  const active = upscaleScales.querySelector('.chip.is-active');
  return Number((active as HTMLElement | null)?.dataset.scale ?? 2);
}

function commitUpscale(): void {
  const mode = upscaleModeSelect.value as UpscaleMode;
  upscaleScaleField.hidden = mode !== 'scale';
  upscaleLongestField.hidden = mode !== 'longest';
  upscaleExactField.hidden = mode !== 'exact';

  const upscale = {
    mode,
    scale: selectedScale(),
    longest: Number(upscaleLongestSelect.value),
    width: Math.max(1, Number(upscaleWidthInput.value) || 1),
    height: Math.max(1, Number(upscaleHeightInput.value) || 1),
    keepAspect: upscaleKeepAspect.checked,
    filter: upscaleFilterSelect.value as UpscaleFilter,
    sharpen: Number(upscaleSharpenInput.value),
    deringing: upscaleDering.checked,
  };

  const engine = upscaleEngineSelect.value as UpscaleEngine;
  // The filter and sharpen controls belong to the classical resampler. Under
  // the model they would be describing work it does not do, so they go away
  // rather than sitting there doing nothing.
  upscaleFilterField.hidden = engine === 'ai';
  upscaleTuningField.hidden = engine === 'ai';
  upscaleAiPanel.hidden = engine !== 'ai';
  upscaleEngineHint.textContent =
    engine === 'ai'
      ? 'Runs a model on your GPU. Nothing is uploaded — the model is downloaded to you.'
      : "Sharper than the browser's own enlargement, and instant.";

  upscaleHint.textContent = describeUpscaleSummary(upscale.mode, upscale);
  converter.updateSettings({ upscale, upscaleEngine: engine });
  syncUpscaleStatus();
}

function describeUpscaleSummary(mode: UpscaleMode, spec: { scale: number; longest: number; width: number; height: number; keepAspect: boolean }): string {
  if (mode === 'longest') return `Longest edge grows to ${spec.longest}px.`;
  if (mode === 'exact') return `${spec.width}×${spec.height}${spec.keepAspect ? ' (fit)' : ' (stretch)'}.`;
  return `${spec.scale}× enlargement.`;
}

/**
 * Keeps the AI panel honest about what will happen: whether the hardware can
 * run it at all, how long the queue will take, and which files are too big.
 */
function syncUpscaleStatus(): void {
  if (converter.isEnhancing) return;

  const supported = converter.aiSupported;
  const model = MODELS[DEFAULT_MODEL_ID];
  const eligible = converter.pendingEnhancement;
  const oversized = converter.oversizedForAi;
  const enhanced = converter.items.filter((item) => converter.isEnhanced(item)).length;

  upscaleRunButton.disabled = supported !== true || eligible.length === 0;
  upscaleResetButton.hidden = enhanced === 0;
  upscaleProgress.hidden = true;
  upscaleCancelButton.hidden = true;

  if (supported === null) {
    upscaleAiStatus.textContent = 'Checking whether this device can run the model…';
    return;
  }
  if (!supported) {
    upscaleAiStatus.textContent =
      'This browser cannot run the model — it needs WebGPU. The standard upscaler still works and is instant.';
    return;
  }

  const parts: string[] = [];
  if (enhanced > 0) parts.push(`${enhanced} image${enhanced === 1 ? '' : 's'} enhanced.`);

  if (eligible.length === 0) {
    if (enhanced > 0) {
      // Nothing pending and something done — say so plainly rather than
      // offering work that does not exist.
      parts.push('Nothing left to enhance at these settings.');
    } else {
      parts.push(
        oversized.length > 0
          ? 'Every image here is too large for the model. Enlarging is for small images; use the standard upscaler.'
          : 'Add a small image to enhance.',
      );
    }
  } else {
    const seconds = converter.estimateEnhanceSeconds();
    parts.push(
      `${eligible.length} image${eligible.length === 1 ? '' : 's'} to enhance, roughly ${
        formatDuration(seconds * 1000) || '1s'
      }.`,
    );
    // The first run pays for the model on top of everything else, and 28MB on
    // a phone connection is worth saying before the button is pressed.
    if (!converter.modelLoaded) parts.push(`First run also downloads the model (${formatBytes(model.bytes)}), once.`);
  }
  if (oversized.length > 0 && eligible.length > 0) {
    parts.push(`${oversized.length} too large and will be skipped.`);
  }

  upscaleAiStatus.textContent = parts.join(' ');
}

for (const chip of Array.from(upscaleScales.querySelectorAll<HTMLButtonElement>('.chip'))) {
  chip.addEventListener('click', () => {
    for (const other of Array.from(upscaleScales.querySelectorAll('.chip'))) {
      other.classList.toggle('is-active', other === chip);
    }
    commitUpscale();
  });
}

upscaleModeSelect.addEventListener('change', commitUpscale);
upscaleLongestSelect.addEventListener('change', commitUpscale);
upscaleWidthInput.addEventListener('change', commitUpscale);
upscaleHeightInput.addEventListener('change', commitUpscale);
upscaleKeepAspect.addEventListener('change', commitUpscale);
upscaleEngineSelect.addEventListener('change', commitUpscale);
upscaleFilterSelect.addEventListener('change', commitUpscale);
upscaleDering.addEventListener('change', commitUpscale);
upscaleSharpenInput.addEventListener('input', () => {
  upscaleSharpenValue.textContent = upscaleSharpenInput.value;
});
upscaleSharpenInput.addEventListener('change', commitUpscale);

upscaleRunButton.addEventListener('click', () => {
  void converter.enhanceAll().catch((error: Error) => {
    upscaleAiStatus.textContent = error.message;
  });
});
upscaleCancelButton.addEventListener('click', () => converter.cancelEnhance());
upscaleResetButton.addEventListener('click', () => {
  converter.clearEnhancements();
  syncUpscaleStatus();
});

resizeLongestSelect.addEventListener('change', commitResize);
resizePercentInput.addEventListener('input', () => {
  resizePercentValue.textContent = resizePercentInput.value;
});
resizePercentInput.addEventListener('change', commitResize);
resizeWidthInput.addEventListener('change', commitResize);
resizeHeightInput.addEventListener('change', commitResize);
resizeKeepAspect.addEventListener('change', commitResize);

/* --------- crop & rotate --------- */

cropRatios.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.chip');
  if (!button) return;
  const value = button.dataset.ratio;
  if (!value) return;

  for (const chip of cropRatios.querySelectorAll('.chip')) chip.classList.remove('is-active');
  if (value === 'clear') {
    applyRatioToAll(null);
    return;
  }
  button.classList.add('is-active');
  const [w, h] = value.split(':').map(Number);
  applyRatioToAll(w / h);
});

function describeTransform(): string {
  const { rotate, flipHorizontal } = converter.settings;
  if (rotate === 0 && !flipHorizontal) return 'No rotation applied.';
  const parts: string[] = [];
  if (rotate !== 0) parts.push(`Rotated ${rotate}°`);
  if (flipHorizontal) parts.push('flipped horizontally');
  return `${parts.join(', ')}.`;
}

function turn(delta: number): void {
  const next = (((converter.settings.rotate + delta) % 360) + 360) % 360;
  converter.updateSettings({ rotate: next as 0 | 90 | 180 | 270 });
  transformHint.textContent = describeTransform();
}

rotateLeftButton.addEventListener('click', () => turn(-90));
rotateRightButton.addEventListener('click', () => turn(90));
flipButton.addEventListener('click', () => {
  converter.updateSettings({ flipHorizontal: !converter.settings.flipHorizontal });
  transformHint.textContent = describeTransform();
});
transformResetButton.addEventListener('click', () => {
  converter.updateSettings({ rotate: 0, flipHorizontal: false });
  transformHint.textContent = describeTransform();
});

/* --------- convert --------- */

formatSelect.addEventListener('change', () => {
  const format = formatSelect.value as OutputFormat;
  formatHint.textContent = FORMAT_NOTES[format];
  qualityInput.disabled = format === 'image/png';
  converter.updateSettings({ format });
});

namePatternInput.addEventListener('change', () => {
  converter.updateSettings({ namePattern: namePatternInput.value });
  const preview = applyNamePattern(namePatternInput.value, {
    original: 'IMG_0042.HEIC',
    index: 1,
    width: 4032,
    height: 3024,
  });
  showToast(`Example: ${preview}.${formatExtension(converter.settings.format)}`);
});

keepExifInput.addEventListener('change', () => {
  converter.updateSettings({ keepExif: keepExifInput.checked });
  keepGpsInput.disabled = !keepExifInput.checked;
});
keepGpsInput.addEventListener('change', () => converter.updateSettings({ keepGps: keepGpsInput.checked }));
keepIccInput.addEventListener('change', () => converter.updateSettings({ keepIcc: keepIccInput.checked }));
keepXmpInput.addEventListener('change', () => converter.updateSettings({ keepXmp: keepXmpInput.checked }));

/* --------- queue actions --------- */

cancelButton.addEventListener('click', () => {
  converter.cancel();
  showToast('Stopped. Files already processed are still here.');
  announce('Processing cancelled.');
});

clearButton.addEventListener('click', () => {
  converter.clear();
  syncChrome();
});

el<HTMLButtonElement>('open-trust').addEventListener('click', openTrustPanel);
el<HTMLButtonElement>('open-privacy').addEventListener('click', openTrustPanel);
el<HTMLButtonElement>('open-about').addEventListener('click', openAboutPanel);

/* -------------------------------------------------------------- downloads */

downloadZipButton.addEventListener('click', async () => {
  const ready = converter.readyItems;
  if (ready.length === 0) return;

  if (ready.length === 1) {
    saveBlob(ready[0].outBlob!, ready[0].outName);
    return;
  }

  const label = downloadZipButton.textContent;
  downloadZipButton.disabled = true;

  const names = dedupeNames(ready.map((item) => item.outName));
  const entries = ready.map((item, index) => ({ name: names[index], blob: item.outBlob! }));
  const onProgress = (done: number, total: number) => {
    downloadZipButton.textContent = `Zipping ${done}/${total}…`;
  };

  try {
    // A normal download is what people expect, so it is the default. The
    // save-to-disk dialog is reserved for batches large enough that holding the
    // whole archive in memory is a genuine risk.
    const totalBytes = ready.reduce((sum, item) => sum + item.outSize, 0);
    const HUGE_BATCH = 250 * 1024 * 1024;

    if (totalBytes > HUGE_BATCH && canStreamToDisk()) {
      const outcome = await streamZipToDisk(entries, 'processed-images.zip', onProgress);
      if (outcome === 'saved') {
        showToast(`${ready.length} files written to your chosen location`);
        return;
      }
      if (outcome === 'cancelled') return;
    }

    const zipBlob = await buildZip(entries, onProgress);
    saveBlob(zipBlob, 'processed-images.zip');
    showToast(`${ready.length} images zipped · ${formatBytes(zipBlob.size)}`);
  } catch (error) {
    showToast((error as Error).message || 'Could not build the ZIP');
  } finally {
    downloadZipButton.textContent = label ?? 'Download all as ZIP';
    syncChrome();
  }
});

downloadPdfButton.addEventListener('click', () => {
  const ready = converter.readyItems;
  if (ready.length === 0) return;

  const container = makeElement('div', 'prose');
  container.appendChild(
    makeElement(
      'p',
      'modal__lede',
      `Combine ${ready.length} image${ready.length === 1 ? '' : 's'} into a single PDF, one per page, in the order shown.`,
    ),
  );

  const modeField = makeElement('label', 'details__field');
  modeField.appendChild(makeElement('span', undefined, 'Page size'));
  const modeSelect = makeElement('select');
  const a4 = makeElement('option', undefined, 'A4 with margins (best for documents)');
  a4.value = 'a4';
  const match = makeElement('option', undefined, 'Match each image exactly (no borders)');
  match.value = 'match';
  modeSelect.append(a4, match);
  modeField.appendChild(modeSelect);
  container.appendChild(modeField);

  const build = makeElement('button', 'btn btn--primary', 'Build PDF');
  build.type = 'button';
  build.addEventListener('click', async () => {
    build.disabled = true;
    build.textContent = 'Building…';
    try {
      const blob = await converter.buildPdfDocument({
        mode: modeSelect.value as 'a4' | 'match',
        margin: 28,
      });
      saveBlob(blob, 'images.pdf');
      closeModal();
      showToast(`PDF built · ${formatBytes(blob.size)}`);
    } catch (error) {
      build.disabled = false;
      build.textContent = 'Build PDF';
      showToast((error as Error).message || 'Could not build the PDF');
    }
  });
  container.appendChild(build);

  openModal('Combine into PDF', container);
});

/* ------------------------------------------------------------------ boot */

function populateFormats(): void {
  const order: OutputFormat[] = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
  formatSelect.replaceChildren();
  for (const format of order) {
    if (!availableFormats.has(format)) continue;
    const option = makeElement('option', undefined, formatLabel(format));
    option.value = format;
    if (format === converter.settings.format) option.selected = true;
    formatSelect.appendChild(option);
  }
}

function boot(): void {
  const capabilities = converter.capabilities;
  if (!capabilities.supported) {
    unsupported.hidden = false;
    appMain.hidden = true;
    unsupportedDetail.textContent = `Missing: ${capabilities.missing.join(', ')}.`;
    return;
  }

  subscribeNetStats((stats) => {
    netCounter.textContent = stats.bytesSent === 0 ? '0 bytes' : formatBytes(stats.bytesSent);
    netCounter.classList.toggle('is-nonzero', stats.bytesSent > 0);
  });

  populateFormats();
  qualityHint.textContent = qualityDescription(Number(qualityInput.value));
  formatHint.textContent = FORMAT_NOTES[converter.settings.format];
  transformHint.textContent = describeTransform();
  syncChrome();

  void detectEncodableFormats().then((formats) => {
    availableFormats = formats;
    populateFormats();
  });

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    // This module is imported lazily, so `load` has usually already fired by
    // now — waiting for it would mean the worker never registers at all.
    const base = import.meta.env.BASE_URL;
    const register = () =>
      navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => undefined);
    if (document.readyState === 'complete') void register();
    else window.addEventListener('load', register, { once: true });
  }
}

boot();
