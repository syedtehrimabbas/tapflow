/** What the display is, and what it is currently showing. */
export interface DisplayMetrics {
  /** The panel's own dimensions, unrotated. `adb wm size` reports this, and the emulator's gRPC
   *  input takes coordinates in it. */
  natural: { width: number; height: number }
  /** What Android is drawing right now — `natural` with the rotation applied. This is the picture a
   *  viewer must frame, and the space a person points at. */
  current: { width: number; height: number }
  /** Quarter turns clockwise from `natural` to `current`: 0, 90, 180 or 270. */
  rotation: 0 | 90 | 180 | 270
}

/**
 * Parse `adb shell dumpsys window displays`.
 *
 * **Why not `wm size`.** That reports only the natural dimensions, and on a rotated display it is
 * the wrong way round for anything a person sees — measured on a Pixel 9 Pro Fold unfolded:
 * `wm size` 2076x2152 while the live screen was 2152x2076.
 *
 * **Why not the emulator's own rotation field.** The gRPC frame carries a `rotation`, and it is the
 * device's *physical* orientation rather than the display's. Folded, it still says
 * `REVERSE_LANDSCAPE` while Android has rotated the screen back to 0 — so a coordinate map built on
 * it is right unfolded and wrong folded. The two agreed until a foldable made them disagree.
 *
 * The line looks like:
 * `init=2076x2152 390dpi mMinSizeOfResizeableTaskDp=220 cur=2152x2076 app=2152x2076 rng=…`
 */
export function parseDisplayMetrics(output: string): DisplayMetrics | null {
  const dims = output.match(/init=(\d+)x(\d+)[^\n]*?cur=(\d+)x(\d+)/)
  if (!dims) return null
  const natural = { width: Number(dims[1]), height: Number(dims[2]) }
  const current = { width: Number(dims[3]), height: Number(dims[4]) }
  // `mRotation=ROTATION_270`. Read rather than derived: a square-ish display (the unfolded foldable
  // is 2076x2152) cannot tell 0 from 180, and derived-from-aspect cannot tell 90 from 270 at all.
  //
  // **One fallback, not two.** An absent field and a value outside the four are the same answer —
  // 0, rather than a guess — and written as two they masked each other: changing either still
  // produced 0, so no test could fail on it and the absent case was never really covered.
  const rot = output.match(/mRotation=ROTATION_(\d+)/)
  const rotation = ([0, 90, 180, 270] as const).find((r) => r === Number(rot?.[1])) ?? 0
  return { natural, current, rotation }
}

/**
 * The rounded-corner radius, in device pixels, of the panel with these natural dimensions.
 *
 * **Read from Android rather than measured off the picture.** `detectCornerRadius` finds the run of
 * black down the frame's left edge, which is the radius only while the frame is upright — and the
 * emulator's capture is a quarter turn from the screen, so on a foldable it measured a side that
 * has no corner on it. Android already knows the number.
 *
 * Folding swaps to a different panel with a different curve: measured on a Pixel 9 Pro Fold, 85px
 * on the 2076-wide inner display and 115px on the 1080-wide cover, so 4.1% becomes 10.6%. The size
 * is what picks between them, because `dumpsys display` lists every panel whether it is on or not.
 *
 * **Returns device pixels, not a fraction.** It used to divide by the panel's natural width, which
 * is the wrong basis the moment the display is rotated: the corner is a physical property of the
 * panel and does not move, but the width the viewer scales it against is the *shown* width, which
 * swaps. Folded and turned to landscape, a cover panel's 115px over 1080 came out 2.24x too round.
 * Matching a panel still uses the natural size, because that is how `dumpsys` lists them — keeping
 * the match and the normalisation on one basis is what produced the bug.
 *
 * Returns null when no panel matches, which leaves the caller's existing value alone rather than
 * flattening the corners to square.
 */
export function parseCornerRadius(output: string, width: number, height: number): number | null {
  // Each panel prints its size and then, further into the same record, its corners. **Found by the record and a
  // built-in display's `local:` id, never by its name**: the name is localised — a Korean system calls it
  // "기본으로 제공되는 화면", measured on Galaxy_S23_API_35 — and keyed on "Built-in Screen" the radius read null on
  // every non-English device, so its screen was cut square with the emulator's black corners showing.
  const blocks = output.split('DisplayDeviceInfo{').slice(1).filter((b) => /^"[^"]*": uniqueId="local:/.test(b))
  for (const block of blocks) {
    const size = block.match(/(\d+) x (\d+)/)
    if (!size || Number(size[1]) !== width || Number(size[2]) !== height) continue
    const radius = block.match(/RoundedCorner\{position=TopLeft, radius=(\d+)/)
    if (!radius) return null
    return Number(radius[1])
  }
  return null
}

/**
 * The panel `screencap -d` must capture on a device with more than one, or null on a device with one.
 *
 * **Why the plain command is wrong there.** With two panels and no `-d`, `screencap -p` warns that no display
 * was chosen and captures "the first display found". The warning goes to stderr, and `adb exec-out` carries
 * stderr in the same stream as the PNG — measured on Pixel_9_Pro_Fold_API_37: 347 bytes of text before the
 * signature, and `file` calls the result "data". The first display is also the inner panel whether or not it
 * is lit: folded, the capture was the dark 2076x2152 inner panel while the 1080x2424 cover was showing the app.
 *
 * **Which panel.** The one behind logical display 0, which is what the agent streams — `streamScreenshot` and
 * scrcpy both take display 0. Folding moves display 0 onto the cover panel, so this is read at each capture
 * rather than once per session. `DisplayInfo{…, displayId 0, …, uniqueId "local:…"}` carries the physical id
 * `-d` takes; the logical id is refused (`-d 0`: "Display Id '0' is not valid").
 *
 * **Null on one panel, so those devices run the exact command they always have.** Nothing warns there. Null
 * too when no `DisplayInfo` describes display 0: another logical display's panel would be the same guess
 * `screencap` makes on its own, and folded it is the wrong one.
 */
export function parseScreencapDisplayId(output: string): string | null {
  const panels = output.split('DisplayDeviceInfo{').slice(1).filter((b) => /^"[^"]*": uniqueId="local:/.test(b))
  if (panels.length < 2) return null
  return output.match(/DisplayInfo\{"[^"]*", displayId 0, [^\n]*?uniqueId "local:(\d+)"/)?.[1] ?? null
}
