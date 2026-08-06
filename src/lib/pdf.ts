/**
 * Builds a PDF from encoded JPEGs.
 *
 * JPEG data can be embedded into a PDF verbatim using the DCTDecode filter, so
 * no re-compression and no PDF library is needed — the bytes we already have go
 * straight in.
 */

export interface PdfPageImage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

export type PdfPageMode = 'a4' | 'match';

export interface PdfOptions {
  mode: PdfPageMode;
  /** Margin in points, applied in A4 mode */
  margin: number;
}

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

const encoder = new TextEncoder();

function ascii(text: string): Uint8Array {
  return encoder.encode(text);
}

interface Placement {
  pageWidth: number;
  pageHeight: number;
  drawWidth: number;
  drawHeight: number;
  x: number;
  y: number;
}

function placeImage(image: PdfPageImage, options: PdfOptions): Placement {
  const landscape = image.width > image.height;

  if (options.mode === 'match') {
    // Page takes the image's own aspect, normalised so the long edge is A4-ish.
    const longEdge = A4_HEIGHT;
    const scale = longEdge / Math.max(image.width, image.height);
    const pageWidth = image.width * scale;
    const pageHeight = image.height * scale;
    return { pageWidth, pageHeight, drawWidth: pageWidth, drawHeight: pageHeight, x: 0, y: 0 };
  }

  const pageWidth = landscape ? A4_HEIGHT : A4_WIDTH;
  const pageHeight = landscape ? A4_WIDTH : A4_HEIGHT;
  const availableWidth = pageWidth - options.margin * 2;
  const availableHeight = pageHeight - options.margin * 2;

  const scale = Math.min(availableWidth / image.width, availableHeight / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;

  return {
    pageWidth,
    pageHeight,
    drawWidth,
    drawHeight,
    x: (pageWidth - drawWidth) / 2,
    y: (pageHeight - drawHeight) / 2,
  };
}

export function buildPdf(images: PdfPageImage[], options: PdfOptions): Blob {
  if (images.length === 0) throw new Error('No pages to write');

  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    length += bytes.length;
  };

  // Object 1 is the catalog, 2 is the page tree, then three objects per page.
  const objectCount = 2 + images.length * 3;
  const offsets = new Array<number>(objectCount + 1).fill(0);

  const beginObject = (id: number): void => {
    offsets[id] = length;
    push(ascii(`${id} 0 obj\n`));
  };
  const endObject = (): void => push(ascii('endobj\n'));

  push(ascii('%PDF-1.4\n'));
  // A binary comment marks the file as containing binary data.
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const pageIds = images.map((_, index) => 3 + index * 3);

  beginObject(1);
  push(ascii('<< /Type /Catalog /Pages 2 0 R >>\n'));
  endObject();

  beginObject(2);
  push(ascii(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${images.length} >>\n`));
  endObject();

  images.forEach((image, index) => {
    const pageId = 3 + index * 3;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const place = placeImage(image, options);

    beginObject(pageId);
    push(
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${place.pageWidth.toFixed(2)} ${place.pageHeight.toFixed(2)}] ` +
          `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\n`,
      ),
    );
    endObject();

    beginObject(imageId);
    push(
      ascii(
        `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.jpeg.length} >>\nstream\n`,
      ),
    );
    push(image.jpeg);
    push(ascii('\nendstream\n'));
    endObject();

    // PDF's image space is a unit square, so the CTM carries the real size.
    const content =
      `q\n${place.drawWidth.toFixed(2)} 0 0 ${place.drawHeight.toFixed(2)} ` +
      `${place.x.toFixed(2)} ${place.y.toFixed(2)} cm\n/Im0 Do\nQ\n`;
    const contentBytes = ascii(content);

    beginObject(contentId);
    push(ascii(`<< /Length ${contentBytes.length} >>\nstream\n`));
    push(contentBytes);
    push(ascii('endstream\n'));
    endObject();
  });

  const xrefOffset = length;
  push(ascii(`xref\n0 ${objectCount + 1}\n`));
  push(ascii('0000000000 65535 f \n'));
  for (let id = 1; id <= objectCount; id++) {
    push(ascii(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`));
  }
  push(ascii(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));

  return new Blob(chunks as unknown as BlobPart[], { type: 'application/pdf' });
}
