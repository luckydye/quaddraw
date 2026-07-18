import type { BrushTexture } from "./types";

const BRISTLE_MASK_WIDTH = 64;
const BRISTLE_MASK_HEIGHT = 32;

// 8-bit alpha lookup generated from assets/bristle-mask.png. Keeping the small
// sampling copy inline makes brush rasterization synchronous and deterministic;
// the PNG remains the editable source and is also used by the preset preview.
const BRISTLE_MASK_BASE64 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEEAgEBAQEFAgUCBwsHDA8bGgkCDQEBBQMKGg0MHQoBBQEDAQIBAQEBAQEBAQEBAQEBAQEBAQEBAgEBAQ0CBgorHx0JBQIMBhMKByMvQkZAOi0YGAoCICMZGTYiFysQDCEQEwsWBwEBAQECAQEBAQEBAQEBAQEBDyEWBwYLBQsSLzgpMhI2QDpmcFiKX35oNx44QTw+Q0xxrY9lj3cvXU5VQGNYMyIbCw8cKSAMAgEBAQEBAQEBAgURI0lJZVuabJSMgZKRttrh5LaSaXnSzJOjys2bZnWD1LXHz8dvQrzSoFt9s4p8a2dEDR0hDQUBAQEBAwYECwcOJkyRv2Ghzb6rsV+GrMzRztfQ0M/g8uLCv9rAu8qyxMvr4b3EiFGY0KZ4f4ZvTWNxQUE1TBciFQkCAQISESo2SlhohYJ51O7V186o0s3h5uXy+fHr+Pb3+fHu793S1eTh5fTv8e3p8Pbp4tvaubLFwK2zl7dym2kuCQICBxcmPkWVnsqvveHh5fP16e3RzOnb5+Dy6vby9fbs9u/38Pb09fb09e/o7/Dp6+fd5e/d19G3kX9SO21eSD4dBA0qVcDJ79jH3OTd1Ozv3Ojn7ujt5vPy+vr7/Pv9/Pz7+vj2+vr5+Pf39Pb19fj28/n57+ri0sqxoJWVXjwmCwtEfpPAyejl7/r8+/r7+vn5+Pr7+vn49fv3+vn7/Pr4+vj19vj4+fr59/n4+PX2+Pb69/fz7erlz69ZJRkKCwYhfmB6r8fu7vf4+vv5+fn5/Pv5+/v7+/r7/Pv7+vv7/Pv6+vr6+/r6+/v5+/v6+fz8/fz8+/jt2s28qZ16MxQEERsleLbf8PX6+/n6+vr7/Pn6/Pz8+/v8/f39/f39/v39/Pr7/Pr7/fv7+/n8/fz9/f39/fv7+vf18+XOn3JTOxJVfKHb+fP39/P49/X6+Pf6+Pf5+vn4+fn6/Pr6/Pv7+/v6+/n5+/v6+fr6/Pz7+/z7+vr4+fj3+O7q6MZ1LyAJFjZds63i9/Hy+Pb2+fj39/n5+fr4+fv8+/z8/P39/P38/P39/Pz7+/n6+/z8/Pz8/Pv48/Lv36y2ysO4iDstERxIf7rT5O339/j59/b5+Pn5+vr5+fr6+vr6+/v6+/z7+/r7+/v6+/n5+vr6+/v6+/z6+vj09Ovp3MOkYCodGgophsjk9vj4+Pj5+vj2+fn4+fr4+vr4+fr6+vn7+vv7/Pv7+/v7+/r5+/v6/Pz7+/v7/Pv6+vr559Lrwnc2DAJGbXiFt+73+Pn5+fr5+Pb4+vr4+vr6+vn5+vr6+vz7/Pv7+vr6+/v7+Pf6+vn5+vn7/Pr5+/r5+fj489esbkVHFEFnj6/l5vDy9/j5+fn6+vr7+/j7+vr7+/r7+vv7/Pz8+/v8+vr6+vn5+Pn49/f4+ff5+uzO6eHe0czMv6t5Pxc3PGujyvH19vn5+fr7+fn5+fb4+Pf2+Pf6+fn6+/v5+/v7+vv5+vr5+fv5+Pr4+fr6+vr6+vn38+SwinZAKBECBRxQl9Dn8vn39/L4+Pf39fX09Pbz9/b29fT09/v4+Pf49PPz9vn49/T09PT19PP39/f3+PDr2a6giUcmGgYBBg8cYaLIxdPc8ff5+fjz9/fx8OrhyNvh1t3k2vXs8Ovr8vTp8PDx6OLo4eru8PDy8PT19vLs7eXZiE9VIw0TCQECAwxCoK3I6+Di5ufy8Ovs7vHr8+nw8ubO28fa6d/e5trWzt7e5+rqyOrq3eHU4ufh1sDS1dHNmYqKk3o1JRAXFipCWIi3or/O08jJxca6v8vGkau82NjA06W23cHVwMHjy7SMo7PY6+fb6d7n4M7U5s26oJ2BmoNuXWNVGwYBBwQCCB5CRTc8goCRpbVtY45kZ1aDf8G/o+S+gZynbpdjgC5LQWVjg5KqnW6dyr3XzZW2z8isbDwxNzEkGRAEAQEBAREMCgcPJCcXCCZUQ1i4P5ZSkHVrO0mNnXt6jElLUUE7KjhaSi0rMlFAbHmap7vK3ZmdREE+QVFWWSYPBAEBAQEBBwIDAxMNFRg1WE4zNCMtMD8oLRwOKko8HlYpKiYvKgsFHkYaDwUTChkcRFBGNTBCRTYcEAkHAgEBAQEBAQEBAQEBAQMDCQoJBAMCCAgDAwMCAgQDAQEBBgQFAgQEBAICAQIJAgEBBgQEAQIBAgICAQIBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQIBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

const bristleMask = decodeBase64(BRISTLE_MASK_BASE64);

/** Samples a brush-tip texture with mirrored horizontal repetition. */
export function sampleBrushTexture(
  texture: BrushTexture,
  along: number,
  across: number,
  seed: number,
): number {
  if (texture !== "bristle") return 1;
  if (across < 0 || across > 1) return 0;

  const phase = hashUnit(seed ^ 0x68bc21eb);
  const repeat = mirroredRepeat(along + phase);
  const vertical = (seed & 1) === 0 ? across : 1 - across;
  return sampleBristleMask(repeat, vertical);
}

/** Samples one complete 2D tip stamp without repeating or circular clipping. */
export function sampleBrushTip(
  texture: BrushTexture,
  along: number,
  across: number,
  seed: number,
): number {
  if (texture !== "bristle") return 1;
  if (along < 0 || along > 1 || across < 0 || across > 1) return 0;
  const horizontal = (seed & 2) === 0 ? along : 1 - along;
  const vertical = (seed & 1) === 0 ? across : 1 - across;
  return sampleBristleMask(horizontal, vertical);
}

/**
 * Converts pressure/density into pigment contact. Lower values remove the
 * weakest parts of a texture while remapping the strongest contacts back to
 * opaque, instead of fading the complete brush imprint uniformly.
 */
export function texturedContactCoverage(
  maskCoverage: number,
  density: number,
): number {
  const normalizedDensity = clamp(density, 0, 1);
  if (normalizedDensity === 0 || maskCoverage <= 0) return 0;
  if (normalizedDensity === 1) return clamp(maskCoverage, 0, 1);
  // A lightly loaded brush keeps its complete tip impression, but its weaker
  // texture values fall away faster than its strongest bristles. This changes
  // texture contrast instead of uniformly fading or punching binary holes.
  return clamp(maskCoverage, 0, 1) ** (1 / normalizedDensity);
}

function sampleBristleMask(horizontal: number, vertical: number): number {
  const x = horizontal * (BRISTLE_MASK_WIDTH - 1);
  const y = vertical * (BRISTLE_MASK_HEIGHT - 1);
  const left = Math.floor(x);
  const top = Math.floor(y);
  const right = Math.min(left + 1, BRISTLE_MASK_WIDTH - 1);
  const bottom = Math.min(top + 1, BRISTLE_MASK_HEIGHT - 1);
  const amountX = x - left;
  const amountY = y - top;
  const topValue = interpolate(maskAt(left, top), maskAt(right, top), amountX);
  const bottomValue = interpolate(maskAt(left, bottom), maskAt(right, bottom), amountX);
  // Discard scanner haze in the nominally transparent source background.
  return clamp((interpolate(topValue, bottomValue, amountY) - 5) / 250, 0, 1);
}

function mirroredRepeat(value: number): number {
  const tile = Math.floor(value);
  const amount = value - tile;
  return Math.abs(tile % 2) === 0 ? amount : 1 - amount;
}

function maskAt(x: number, y: number): number {
  return bristleMask[y * BRISTLE_MASK_WIDTH + x];
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (bytes.length !== BRISTLE_MASK_WIDTH * BRISTLE_MASK_HEIGHT) {
    throw new Error("Invalid embedded bristle texture");
  }
  return bytes;
}

function hashUnit(seed: number): number {
  let value = seed >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return value / 0xffffffff;
}

function interpolate(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
