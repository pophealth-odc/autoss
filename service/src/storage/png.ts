const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ImageSize {
  width: number;
  height: number;
}

/** Reads the pixel size from the IHDR chunk of a PNG (needs at least the first 24 bytes). Returns null for anything else. */
export function readPngSize(head: Buffer): ImageSize | null {
  if (head.length < 24) return null;
  if (!head.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (head.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}
