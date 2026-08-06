import libheifFactory, { type LibHeifModule } from 'libheif-js/libheif-wasm/libheif-bundle.mjs';

import type { DecodeRequest } from '../types';

let module: LibHeifModule | null = null;

function getModule(): LibHeifModule {
  if (!module) module = libheifFactory();
  return module;
}

async function decode(buffer: ArrayBuffer): Promise<{ bitmap: ImageBitmap; width: number; height: number }> {
  const decoder = new (getModule().HeifDecoder)();
  const images = decoder.decode(new Uint8Array(buffer));

  if (!images || images.length === 0) {
    throw new Error('No image found inside this file');
  }

  // Index 0 is the primary image; the rest are depth maps, thumbnails or
  // burst frames, which we deliberately ignore.
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();

  if (!width || !height) throw new Error('Image reports invalid dimensions');

  const imageData = new ImageData(width, height);
  await new Promise<void>((resolve, reject) => {
    image.display(imageData, (result) => {
      if (result) resolve();
      else reject(new Error('libheif could not decode this image'));
    });
  });

  for (const img of images) img.free?.();

  const bitmap = await createImageBitmap(imageData);
  return { bitmap, width, height };
}

self.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const { id, buffer } = event.data;
  try {
    const { bitmap, width, height } = await decode(buffer);
    self.postMessage({ id, ok: true, bitmap, width, height }, { transfer: [bitmap] });
  } catch (error) {
    self.postMessage({ id, ok: false, error: (error as Error).message || 'Decode failed' });
  }
};
