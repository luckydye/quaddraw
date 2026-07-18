import type { BrushTexture } from "./types";

const BRISTLE_MASK_WIDTH = 64;
const BRISTLE_MASK_HEIGHT = 32;
// The source is a photographed swatch with transparent scanner margins above
// and below the actual pigment. The rasterizer already supplies the circular
// brush silhouette, so sampling those margins would flatten both sides of a
// dot (and expose hard wedges wherever curve pieces meet).
const BRISTLE_PAINT_TOP = 0.22;
const BRISTLE_PAINT_BOTTOM = 0.76;
const BRISTLE_GRAIN_CONTRAST = 3.2;

// 8-bit alpha lookup generated from assets/bristle-mask.png. Keeping the small
// sampling copy inline makes brush rasterization synchronous and deterministic;
// the PNG remains the editable source and is also used by the preset preview.
const BRISTLE_MASK_BASE64 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQICAQIBAQECAQEBAQEBAQEBAQEBAQECAQEBAQEBAQEBAQEBAQEBAgICAgEBAQEBAQEBAQACAQABAAEEAgABAQEAAAAAAAEAAAABAQIBAQEBAgICAwIAAAAAAQICAQIBAQIBAQEBAQAAAAUDAgICAQACAgUIAAEGAAoAAA0ECgYHFRQZFgsECQ4LAQEAAAcCBAgQEwsADhgSDAIAAAQBAQAAAAEBAwUhIBYaIAQGAAsFBgcACg4IFAQULCJAQkJFRD1JNh4OCwkPAQAGJSgYHBAUKjgWEBQrMgEACiEOBxwNBhAZBBAJGDguNxwYOxIpOkhJN1xpeFM8dodLdI2BblAxGzFNT0hEOUY2PUpJg56ShnaBnI9rNyhdXldtOzFcVlhSJA6cb3Kvsp+NgaGMm6rF19zn7N6loZZyWqDOybaaeJCb2cu1nm9jbY16v+TJw+DGu8ysUxF50sDfwHVnXKm2nXyF2sifpq+fXUegocbS0M7Q0dzdydjM0uLp9/vcv9bLw+XEw7mnya6xy9HR5univ8DHqYNoYafG3LKFhIiRm52LdubK1tDDvJW228TH4uXs6uPr9PXs6Ojw9Pf1+Pv99P7s8PHp4uDj5+/s5enw9fP7+v/z6dvr9fDm19HHxM+5pKjT7/H7/v/37vvmyM/m59D56uHr9evr9/jx+fTy+Ofw+Oz49ens9PLv9fb19vX28vDl6O7y8ezv8+zu4ujk6vHk3O317dff6uDo8t/d6ebT+evh8Pn19vz7+vz5+/z6+/r++/n6+fX4+fj5+ff39vX28u7z9fLy9ff79/X2/Pz67/75+fr6+fr69vr///v9/fn5+Pf7+vn6+fn7/P37+/n6+/j49vP09/f4+fn5+fr3+Pj7+Pr59/T29vj49/n69/f4+vj5+fr7/Pv6+fr8+vr6+/v6+vz7+vv7+vr7+/v8/Pz8+/n7+/r7/Pr6+vv8/Pv7+fv8/Pr8/Pj8/Pz8/fz8+vr6/Pz7+vr6+vz8/Pz7/Pz6/Pz8/f39/P39/P3+/f39/fz7+vv8/Pr5+/v8/fr7/Pv5+fz9/Pv7/vz9/f39/ff6+fb3+fv5+Pj0+Pv6+fr5+fr6+fv8/fr5+/v8+/v7+vr7+vj7+/n5+fv6+/r6+fn6+fv8/Pz7+/v8/fz7+vr2+Pr4+Pb4+fn5+fj6+fn3+fr8/Pv7+/z8/P39/P39/P39/Pz9/f3+/vz8/Pz7+/r6+/v8/Pz8+/z8/Pz8/Pv69Pb6+fj4+Pj6+vv6+vj5+vr6+vr6+vr7+vv7+fv6/Pz7/Pv6+vz7+/v7+vn6+fn5+vr5+fr7+vv6+vr7/Pv6+vj29/n6+Pj5+fn5+Pn7+vj4+fj6+fr6+vn5+/r6+/v7/Pz6+vv7+/v7+/v6+vn7+/v6+vv8/Pz8+/v8+/v8/Pz49/f29/r6+vn49/n6+vr6+/r4+fr6+fr7+fr8/Pv7/Pv7+/v7+vr6+vv6+/v59/j5+vv6+Pn6+vn5+/v8+/n5+fr5+vn6+vr7/Pv5+/v6+/r6+/z6+vz6+fv7+/z8/Pv8/Pv7+/z7+vr6+vv6+vn6+Pn59/j59vf49/v59/r5+/v7+vf5+Pn5+fj2+fj4+Pf2+Pn3+Pn5+Pr5+vr6+vr5+vv6+vv6+/z6+fv5+Pn3+fn6+fj3+fn4+fr6+vj7+vn3+ff3+fb48fj18/P09/T0+ff18vj49/P29Pj8//n5+/n5+vn09vPz9fb4+fr69vT09PP29PX08/Pz9/b38vb4+fb47/D38+7x8Ovn5uPFw9v108/h0OXl0+X78OTy7Ofk9u7o9ens6+/w7/Do5Ovv5Obu6fLy7vLt8vTw9ffz9vP7/fb09vPs9fny9PPy7O3y9ujm4cjb48bP4+/k4d/X2vLayOHL2+zi4u7o5+TdwdXm7e7X2+LVy9je4ene17/FvMXAtrK/tsrQl468mbLe1tvg0MDnv4as0Ni30cyvvrS259PCy3yTtbPDxOTx9N/c3uDe3N/x3dDb4dPnz9DTqLmiVFJ9mHBxiT9GnmVVyLuqwJeo6sydiXy9pp10dKpyaJBQKFI/M1RVTGqPmJy4tqduhqGr3c2dz9a5lIy/yURkbkA9isVfKIuTQHGYaJB3VT0/cKK/qI1jf6SKSE5aYklDSjAhNzRJZFMoJCkaJFs6LlZkZ3ShoLbGx8Ld3rs/RU5ILDdKJCAtRy82RikbJiEPBBUpST1BFhVOQxgfIxweK0IbCAsCEDdNLhIFDQANEgsKKx0kSlFcZz5DPDtJBAIBAAkCAQAFAAAAAwQBAAQDBAIAAAAAAAIHAgwFAw8JAQsAAAMAAQAACgYBBAADCggBBwAAAgIAAAAAAAAAAAECAQIAAQECAAIDAQAAAQIBAQABAQMEAwICAQEAAAEAAAEAAgEBAQEBAgAAAQEBAQAAAQABAgEBAgQDAwMDAwQBAQEBAgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAgEBAgIBAQEBAQEBAQECAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

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
  const tipAcross = (seed & 1) === 0 ? across : 1 - across;
  const vertical = interpolate(BRISTLE_PAINT_TOP, BRISTLE_PAINT_BOTTOM, tipAcross);
  const x = repeat * (BRISTLE_MASK_WIDTH - 1);
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
  const pigment = clamp((interpolate(topValue, bottomValue, amountY) - 5) / 250, 0, 1);
  return pigment ** BRISTLE_GRAIN_CONTRAST;
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
