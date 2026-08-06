declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  export interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(data: ImageData, cb: (result: ImageData | null) => void): void;
    free?(): void;
  }

  export interface HeifDecoder {
    decode(buffer: Uint8Array): HeifImage[];
  }

  export interface LibHeifModule {
    HeifDecoder: new () => HeifDecoder;
  }

  /**
   * Emscripten factory. The wasm binary is inlined in this bundle, so the module
   * is instantiated synchronously and the factory returns the module directly
   * (not a promise) — awaiting it is still safe.
   */
  const factory: (options?: Record<string, unknown>) => LibHeifModule;
  export default factory;
}
