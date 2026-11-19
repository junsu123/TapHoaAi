// The frame the LIVE app captures (game window or Link / Browser Source) must be portrait 9:16.

/**
 * Wider than the game page fills (up to 3:5 it fills the whole frame): the game sits in the
 * middle with dark bars on both sides, so the LIVE app gets a picture wider than its portrait frame.
 */
export function frameTooWide(frame: readonly [number, number] | null | undefined): boolean {
  if (!frame || !(frame[0] > 0 && frame[1] > 0)) return false;
  return frame[0] / frame[1] > 3 / 5 + 0.002;
}
