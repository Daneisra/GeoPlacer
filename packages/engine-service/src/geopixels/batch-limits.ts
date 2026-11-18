/** Resource bounds of our channel, not an undocumented GeoPixels server limit.
 * Integer coordinates/colors need <160 UTF-8 bytes each; 4 KiB are reserved for metadata.
 * Source: GeoPixelsFront@74783af, index.js/placePixels sends the whole native queue. */
export const CONNECTOR_COMMAND_BYTES = 128 * 1024;
export const CONNECTOR_MAX_GROUP_PIXELS = Math.floor((CONNECTOR_COMMAND_BYTES - 4096) / 160);
export const INITIAL_GROUP_PIXELS = 16;
