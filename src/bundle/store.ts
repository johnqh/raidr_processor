export interface ContentStore {
  put(bytes: Uint8Array): Promise<string>;
  get(hash: string): Promise<Uint8Array | null>;
  has(hash: string): Promise<boolean>;
  count(): Promise<number>;
  totalBytes(): Promise<number>;
}

export type HashFn = (bytes: Uint8Array) => Promise<string>;

/**
 * In-memory content store. The hash function is injected because raidr_processor
 * cannot assume a platform crypto API exists.
 */
export class MemoryContentStore implements ContentStore {
  private rows = new Map<string, Uint8Array>();

  constructor(private readonly hash: HashFn) {}

  async put(bytes: Uint8Array): Promise<string> {
    const key = await this.hash(bytes);
    if (!this.rows.has(key)) this.rows.set(key, bytes);
    return key;
  }

  async get(hash: string): Promise<Uint8Array | null> {
    return this.rows.get(hash) ?? null;
  }

  async has(hash: string): Promise<boolean> {
    return this.rows.has(hash);
  }

  async count(): Promise<number> {
    return this.rows.size;
  }

  async totalBytes(): Promise<number> {
    let total = 0;
    for (const bytes of this.rows.values()) total += bytes.byteLength;
    return total;
  }
}
