import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { constants, createBrotliCompress, createGzip, brotliDecompress, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

export async function compressFile(filePath) {
  const original = await readFile(filePath);
  const encodings = [
    [
      "br",
      () => createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }),
      promisify(brotliDecompress),
    ],
    ["gz", createGzip, promisify(gunzip)],
  ];
  for (const [extension, createCompressor, decompress] of encodings) {
    const target = `${filePath}.${extension}`;
    // Validate existing sidecars, including ones left by older publishers.
    const existing = await readFile(target).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      const decoded = await decompress(existing).catch(() => null);
      if (decoded?.equals(original)) continue;
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      // A serving instance must never expose a partially written compressed file.
      await pipeline(createReadStream(filePath), createCompressor(), createWriteStream(temporary));
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
