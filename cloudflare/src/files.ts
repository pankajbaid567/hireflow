import { ApiError, type Env } from './types';

export interface FileObject {
  readonly size: number;
  readonly body: ReadableStream<Uint8Array>;
  readonly httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}
interface FileOptions { httpMetadata?: { contentType?: string }; }
interface FileStore {
  put(key: string, value: string | ArrayBuffer | Uint8Array, options?: FileOptions): Promise<void>;
  get(key: string): Promise<FileObject | null>;
  delete(key: string): Promise<void>;
}
interface FileMetadata { contentType?: string; size?: number; }

// Bindings remain request-scoped. Existing R2 deployments keep their storage;
// owner workspaces without R2 billing activation can use native binary KV.
// All callers use immutable object keys and enforce authentication separately.
export function files(env: Env): FileStore {
  const bucket = env.FILES;
  if (bucket) return {
    async put(key, value, options) { await bucket.put(key, value, options); },
    get: key => bucket.get(key),
    delete: key => bucket.delete(key),
  };
  const namespace = env.FILES_KV;
  if (!namespace) throw new ApiError(503, 'Configure private file storage before uploading or generating files');
  return {
    async put(key, value, options) {
      // Encode UTF-8 once for accurate byte metadata; binary PDFs never pass
      // through base64 or per-byte JavaScript conversion.
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      await namespace.put(key, bytes, { metadata: { size: bytes.byteLength, contentType: options?.httpMetadata?.contentType || 'application/octet-stream' } });
    },
    async get(key) {
      const result = await namespace.getWithMetadata<FileMetadata>(key, { type: 'arrayBuffer' });
      if (result.value === null) return null;
      const response = new Response(result.value);
      return {
        size: result.value.byteLength,
        httpMetadata: { contentType: result.metadata?.contentType || 'application/octet-stream' },
        body: response.body!,
        arrayBuffer: () => response.arrayBuffer(),
        text: () => response.text(),
      };
    },
    delete: key => namespace.delete(key),
  };
}
