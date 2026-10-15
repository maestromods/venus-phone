// Strips metadata (EXIF incl. GPS, XMP, IPTC, comments, text chunks) from uploaded photos before
// they are stored or sent anywhere. Pixel data and colour profiles are kept as they are.

/** JPEG: drop APP1 (EXIF/XMP), APP3–APP15 (IPTC, vendor data) and COM segments. */
function stripJpeg(input: Buffer): Buffer {
  if (input[0] !== 0xff || input[1] !== 0xd8) throw new Error("not a JPEG");
  const parts: Buffer[] = [input.subarray(0, 2)];
  let at = 2;
  while (at + 4 <= input.length) {
    if (input[at] !== 0xff) throw new Error("bad JPEG segment");
    const marker = input[at + 1] ?? 0;
    // Start of scan: the rest is image data up to EOI; keep it all.
    if (marker === 0xda) {
      parts.push(input.subarray(at));
      return Buffer.concat(parts);
    }
    // Standalone markers with no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(input.subarray(at, at + 2));
      at += 2;
      continue;
    }
    const length = input.readUInt16BE(at + 2);
    const end = at + 2 + length;
    if (length < 2 || end > input.length) throw new Error("bad JPEG segment length");
    // Keep APP0 (JFIF) and APP2 (ICC profile); drop APP1, APP3–APP15 and comments.
    const drop = marker === 0xe1 || (marker >= 0xe3 && marker <= 0xef) || marker === 0xfe;
    if (!drop) parts.push(input.subarray(at, end));
    at = end;
  }
  throw new Error("JPEG has no image data");
}

/** PNG: drop text, EXIF and timestamp chunks. */
function stripPng(input: Buffer): Buffer {
  const signature = input.subarray(0, 8);
  const parts: Buffer[] = [signature];
  const dropped = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
  let at = 8;
  while (at + 12 <= input.length) {
    const length = input.readUInt32BE(at);
    const type = input.toString("latin1", at + 4, at + 8);
    const end = at + 12 + length;
    if (end > input.length) throw new Error("bad PNG chunk");
    if (!dropped.has(type)) parts.push(input.subarray(at, end));
    at = end;
    if (type === "IEND") return Buffer.concat(parts);
  }
  throw new Error("PNG has no end");
}

/** WebP: drop EXIF and XMP chunks and clear their flags in VP8X. */
function stripWebp(input: Buffer): Buffer {
  if (input.toString("latin1", 0, 4) !== "RIFF" || input.toString("latin1", 8, 12) !== "WEBP") throw new Error("not a WebP");
  const chunks: Buffer[] = [];
  let at = 12;
  while (at + 8 <= input.length) {
    const type = input.toString("latin1", at, at + 4);
    const size = input.readUInt32LE(at + 4);
    const end = at + 8 + size + (size % 2);
    if (at + 8 + size > input.length) throw new Error("bad WebP chunk");
    if (type !== "EXIF" && type !== "XMP ") {
      const chunk = Buffer.from(input.subarray(at, Math.min(end, input.length)));
      // VP8X flags byte: bit 3 = EXIF, bit 2 = XMP.
      if (type === "VP8X" && chunk.length > 8) chunk[8] = (chunk[8] ?? 0) & ~0b1100;
      chunks.push(chunk);
    }
    at = end;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, "latin1");
  return Buffer.concat([header, body]);
}

export function stripImageMetadata(bytes: Buffer, mimeType: string): Buffer {
  if (mimeType === "image/jpeg") return stripJpeg(bytes);
  if (mimeType === "image/png") return stripPng(bytes);
  if (mimeType === "image/webp") return stripWebp(bytes);
  throw new Error("unsupported image type");
}
