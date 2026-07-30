import * as fflateModule from 'fflate/browser';

function moduleDefault(value: unknown): unknown {
  return (value as Record<string, unknown>).default;
}

const fflateRecord = fflateModule as unknown as Record<string, unknown>;
const fflate = (
  typeof fflateRecord.gzipSync === 'function'
    ? fflateModule
    : moduleDefault(fflateModule)
) as typeof fflateModule;

export const deflateSync = fflate.deflateSync;
export const gzipSync = fflate.gzipSync;
export const gunzipSync = fflate.gunzipSync;
export const inflateSync = fflate.inflateSync;

export const constants = {
  Z_BEST_COMPRESSION: 9,
  Z_BEST_SPEED: 1,
  Z_DEFAULT_COMPRESSION: -1,
};
