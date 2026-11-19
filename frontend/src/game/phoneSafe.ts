// TikTok sends the 9:16 picture (1080 × 1920), but phones are taller and narrower (about 9:19.5 to
// 9:20.5): the app fills the phone's screen and cuts both sides of the picture — about 9 % each
// side on a 9:19.5 phone, 11 % on a 9:20.5 one. Everything that must be seen stays in the middle.

/** Part of the frame's width a phone may cut on each side. */
export const PHONE_SIDE = 0.11;

/** How much the 3D camera zooms out so the shop that filled the 9:16 frame fits the phone's middle. */
export const PHONE_ZOOM = 1 - 2 * PHONE_SIDE * 0.9; // 0.802: the shop's outer edge just inside the cut

/**
 * Left edge (fraction of the frame width) for a box `width` wide that wants to start at `x`, moved
 * just enough that the whole box stays where phones still show it. A box wider than the visible
 * middle is centred.
 */
export function keepOnPhone(x: number, width: number, side = PHONE_SIDE): number {
  const lo = side;
  const hi = 1 - side - width;
  if (hi < lo) return Math.max(0, (1 - width) / 2);
  return Math.min(hi, Math.max(lo, x));
}

/** Centre (fraction of the frame width) for a box centred at `cx`, kept where phones show it. */
export function centreOnPhone(cx: number, width: number, side = PHONE_SIDE): number {
  return keepOnPhone(cx - width / 2, width, side) + width / 2;
}
