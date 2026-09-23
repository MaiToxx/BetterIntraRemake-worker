/** Types of scripts/strip-image-metadata.mjs, for the tests. */
export declare const IMAGE_PREFIX: string;

export interface ImageKv {
  list(prefix: string): Promise<{ name: string; metadata?: unknown }[]>;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array, metadata: unknown): Promise<void>;
}

export declare function restripImages(
  kv: ImageKv,
  options?: { apply?: boolean; log?: (line: string) => void },
): Promise<{ cleaned: string[]; alreadyClean: string[]; skipped: string[] }>;
