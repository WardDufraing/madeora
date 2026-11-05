/** The few parts of `heic-decode` (ISC) that photo processing uses; the package ships no types. */
declare module "heic-decode" {
  interface DecodedImage {
    readonly width: number;
    readonly height: number;
    /** RGBA, 4 bytes a pixel, already rotated and mirrored by the file's own transforms. */
    readonly data: Uint8ClampedArray;
  }
  export default function decode(input: {
    buffer: ArrayBufferLike | Uint8Array;
  }): Promise<DecodedImage>;
}
