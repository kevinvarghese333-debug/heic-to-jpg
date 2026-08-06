import {
  detectEncodableFormats,
  formatExtension,
  formatLabel,
  type OutputFormat,
} from './lib/capabilities';
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
import { subscribeNetStats } from './lib/netGuard';
import { buildZip, canStreamToDisk, streamZipToDisk } from './lib/zip';
import { Converter } from './state';
import type { ItemOverride, QueueItem } from './types';

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
const formatSelect = el<HTMLSelectElement>('format');
const formatHint = el<HTMLElement>('format-hint');
const qualityInput = el<HTMLInputElement>('quality');
const qualityValue = el<HTMLOutputElement>('quality-value');
const qualityHint = el<HTMLElement>('quality-hint');
const maxDimensionSelect = el<HTMLSelectElement>('max-dimension');
const targetSizeInput = el<HTMLInputElement>('target-size');
const targetClearButton = el<HTMLButtonElement>('target-clear');
const targetHint = el<HTMLElement>('target-hint');
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

function openModal(title: string, body: HTMLElement): void {
  lastFocused = document.activeElement as HTMLElement | null;
  modalTitle.textContent = title;
  modalBody.replaceChildren(body);
  modal.hidden = false;
  modalClose.focus();
}

function closeModal(): void {
  modal.hidden = true;
  modalBody.replaceChildren();
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
  onQueueChanged: syncChrome,
});

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

  const compare = makeElement('button', 'iconbtn', '◐');
  compare.type = 'button';
  compare.title = 'Compare with original';
  compare.setAttribute('aria-label', `Compare ${item.file.name} with the original`);
  compare.disabled = true;
  compare.addEventListener('click', () => void openCompare(item));

  const details = makeElement('button', 'iconbtn', 'i');
  details.type = 'button';
  details.title = 'Details, metadata and per-file settings';
  details.setAttribute('aria-label', `Details for ${item.file.name}`);
  details.disabled = true;
  details.addEventListener('click', () => openDetails(item));

  actions.append(download, compare, details);
  body.append(name, meta, delta, note, actions);
  root.append(thumb, body);
  grid.appendChild(root);

  cards.set(item.id, { root, image, badge, name, meta, delta, note, download, compare, details });
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
    refs.compare.disabled = true;
    refs.details.disabled = true;
    refs.download.textContent = item.status === 'cancelled' ? 'Cancelled' : 'Failed';
    return;
  }

  if (item.status === 'decoding' || item.status === 'queued') {
    refs.meta.textContent = item.status === 'queued' ? 'Waiting…' : 'Decoding…';
    refs.delta.textContent = '';
    return;
  }

  if (item.outBlob) {
    const resized = item.outWidth !== item.srcWidth;
    refs.meta.textContent = `${item.outWidth}×${item.outHeight}${resized ? ' ↓' : ''} · ${formatBytes(item.outSize)}`;
    refs.delta.className = 'card__delta';
    const change = percentChange(item.file.size, item.outSize);
    refs.delta.classList.toggle('is-larger', change.endsWith('larger'));
    refs.delta.textContent = change ? `${formatBytes(item.file.size)} → ${change}` : '';
    refs.note.textContent = item.notes.length > 0 ? item.notes[0] : '';
    refs.download.disabled = item.encoding;
    refs.download.textContent = item.encoding ? 'Updating…' : 'Download';
    refs.compare.disabled = item.encoding;
    refs.details.disabled = false;
  } else {
    refs.meta.textContent = 'Encoding…';
    refs.delta.textContent = '';
    refs.download.disabled = true;
  }
}

/* -------------------------------------------------------------- modals */

async function openCompare(item: QueueItem): Promise<void> {
  if (!item.outBlob) return;

  const container = makeElement('div', 'compare');
  container.appendChild(makeElement('p', 'modal__lede', 'Drag the divider to compare the original against the converted file.'));

  const stage = makeElement('div', 'compare__stage');
  const loading = makeElement('p', 'compare__loading', 'Rendering the original…');
  stage.appendChild(loading);
  container.appendChild(stage);

  const stats = makeElement('p', 'compare__stats');
  stats.textContent = `Original ${formatBytes(item.file.size)} · Converted ${formatBytes(item.outSize)} · quality ${Math.round(item.qualityUsed * 100)}`;
  container.appendChild(stats);

  openModal(item.outName, container);

  let originalUrl: string;
  try {
    originalUrl = await converter.renderSourcePreview(item.id);
  } catch {
    loading.textContent = 'Could not render the original for comparison.';
    return;
  }

  const outputUrl = URL.createObjectURL(item.outBlob);
  const before = makeElement('img', 'compare__img compare__img--before');
  before.src = originalUrl;
  before.alt = 'Original';
  const afterWrap = makeElement('div', 'compare__after');
  const after = makeElement('img', 'compare__img');
  after.src = outputUrl;
  after.alt = 'Converted';
  afterWrap.appendChild(after);

  const handle = makeElement('div', 'compare__handle');
  const labelBefore = makeElement('span', 'compare__tag compare__tag--left', 'Original');
  const labelAfter = makeElement('span', 'compare__tag compare__tag--right', 'Converted');

  stage.replaceChildren(before, afterWrap, handle, labelBefore, labelAfter);

  const setPosition = (ratio: number) => {
    const clamped = Math.max(0, Math.min(1, ratio));
    afterWrap.style.width = `${clamped * 100}%`;
    handle.style.left = `${clamped * 100}%`;
  };
  setPosition(0.5);

  const onPointer = (event: PointerEvent) => {
    const rect = stage.getBoundingClientRect();
    setPosition((event.clientX - rect.left) / rect.width);
  };
  stage.addEventListener('pointerdown', (event) => {
    stage.setPointerCapture(event.pointerId);
    onPointer(event);
  });
  stage.addEventListener('pointermove', (event) => {
    if (event.buttons > 0) onPointer(event);
  });

  // Object URLs are released when the modal closes.
  const cleanup = () => {
    URL.revokeObjectURL(originalUrl);
    URL.revokeObjectURL(outputUrl);
  };
  modalClose.addEventListener('click', cleanup, { once: true });
}

function openDetails(item: QueueItem): void {
  const container = makeElement('div', 'details');

  /* --- per-file overrides --- */
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

  /* --- metadata studio --- */
  const metaSection = makeElement('section', 'details__section');
  metaSection.appendChild(makeElement('h3', undefined, 'Metadata'));

  const exif = item.metadata.exif;
  if (!exif) {
    metaSection.appendChild(
      makeElement('p', 'details__empty', 'This file carries no EXIF metadata.'),
    );
  } else {
    const gps = readGpsPosition(exif);
    if (gps) {
      const warning = makeElement('p', 'details__warning');
      warning.append(
        makeElement('strong', undefined, 'This photo knows where it was taken. '),
        document.createTextNode(
          `${gps.latitude.toFixed(5)}, ${gps.longitude.toFixed(5)} — remove the GPS rows below, or switch Location off in the main settings, before sharing it publicly.`,
        ),
      );
      metaSection.appendChild(warning);
    }

    const fields = describeExif(exif);
    const table = makeElement('table', 'metatable');
    const tbody = makeElement('tbody');

    for (const field of fields) {
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
    <p>This page converts your photos using WebAssembly running inside your own browser.
       There is no server to upload to. Here is how to confirm that rather than take our word:</p>
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
    <p>A browser-based HEIC/HEIF converter. Decoding is done by
       <strong>libheif</strong> compiled to WebAssembly; encoding uses your browser's own
       image encoders.</p>
    <h3>Licences</h3>
    <p><strong>libheif</strong> — LGPL-2.1-or-later.
       Source: <code>https://github.com/strukturag/libheif</code>.
       It is used here as an unmodified compiled library, and you are free to obtain,
       modify and relink it under the terms of the LGPL.</p>
    <p><strong>libde265</strong> (HEVC decoding, bundled inside the libheif build) — LGPL-3.0.</p>
    <p><strong>fflate</strong> — MIT, used for ZIP writing and PNG chunk compression.</p>
    <h3>Formats</h3>
    <p>Reads HEIC, HEIF and AVIF containers, including Apple's tiled-grid layout used for
       large iPhone photos. Writes JPG, PNG, WebP and AVIF where your browser supports them,
       plus PDF.</p>
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
  dropzoneTitle.textContent = hasItems ? 'Add more photos' : 'Drop HEIC photos here';

  if (!hasItems) return;

  const parts = [`${ready} of ${total} ready`];
  if (failed > 0) parts.push(`${failed} failed`);
  resultsTitle.textContent = `Converted · ${parts.join(' · ')}`;

  cancelButton.hidden = !busy;

  if (busy) {
    const done = ready + failed;
    const eta = etaMs ? ` · about ${formatDuration(etaMs)} left` : '';
    resultsProgress.textContent = `Working on ${done + 1} of ${total}${eta}`;
  } else {
    resultsProgress.textContent = total > 0 ? `${formatBytes(converter.totalOutputSize)} total` : '';
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
  downloadZipButton.textContent =
    ready === 1 ? 'Download file' : `Download all as ZIP (${ready})`;
}

/* ---------------------------------------------------------- input wiring */

function acceptFiles(fileList: FileList | null): void {
  if (!fileList || fileList.length === 0) return;
  const files = Array.from(fileList);
  converter.addFiles(files);
  announce(`${files.length} file${files.length === 1 ? '' : 's'} added, converting.`);
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

formatSelect.addEventListener('change', () => {
  const format = formatSelect.value as OutputFormat;
  formatHint.textContent = FORMAT_NOTES[format];
  qualityInput.disabled = format === 'image/png';
  converter.updateSettings({ format });
});

qualityInput.addEventListener('input', () => {
  const quality = Number(qualityInput.value);
  qualityValue.textContent = String(quality);
  qualityHint.textContent = qualityDescription(quality);
});
qualityInput.addEventListener('change', () =>
  converter.updateSettings({ quality: Number(qualityInput.value) / 100 }),
);

maxDimensionSelect.addEventListener('change', () =>
  converter.updateSettings({ maxDimension: Number(maxDimensionSelect.value) }),
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

cancelButton.addEventListener('click', () => {
  converter.cancel();
  showToast('Stopped. Files already converted are still here.');
  announce('Conversion cancelled.');
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
    // Streaming straight to disk keeps a huge batch out of memory entirely.
    if (canStreamToDisk()) {
      const saved = await streamZipToDisk(entries, 'converted-photos.zip', onProgress);
      if (saved) {
        showToast(`${ready.length} files written to your chosen location`);
        return;
      }
    }
    const zipBlob = await buildZip(entries, onProgress);
    saveBlob(zipBlob, 'converted-photos.zip');
    showToast(`${ready.length} photos zipped · ${formatBytes(zipBlob.size)}`);
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
      `Combine ${ready.length} photo${ready.length === 1 ? '' : 's'} into a single PDF, one per page, in the order shown.`,
    ),
  );

  const modeField = makeElement('label', 'details__field');
  modeField.appendChild(makeElement('span', undefined, 'Page size'));
  const modeSelect = makeElement('select');
  const a4 = makeElement('option', undefined, 'A4 with margins (best for documents)');
  a4.value = 'a4';
  const match = makeElement('option', undefined, 'Match each photo exactly (no borders)');
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
      saveBlob(blob, 'photos.pdf');
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
  syncChrome();

  void detectEncodableFormats().then((formats) => {
    availableFormats = formats;
    populateFormats();
  });

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    // This module is imported lazily, so `load` has usually already fired by
    // now — waiting for it would mean the worker never registers at all.
    const register = () => navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    if (document.readyState === 'complete') void register();
    else window.addEventListener('load', register, { once: true });
  }
}

boot();
