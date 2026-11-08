import { describe, it, expect } from 'vitest'
import { parseDisplayMetrics, parseCornerRadius, parseScreencapDisplayId } from '../displayMetrics'

// Verbatim from a Pixel 9 Pro Fold (API 36), 2026-09-18. The two postures are the whole point: the
// panel changes, and so does whether Android is rotating it.
const UNFOLDED = `  Display: mDisplayId=0
    init=2076x2152 390dpi mMinSizeOfResizeableTaskDp=220 cur=2152x2076 app=2152x2076 rng=2076x2076-2152x2152
  overrideConfig={1.0 [en_US] land winConfig={ mBounds=Rect(0, 0 - 2152, 2076) mDisplayRotation=ROTATION_270 mRotation=ROTATION_270} }`

const FOLDED = `  Display: mDisplayId=0
    init=1080x2424 390dpi mMinSizeOfResizeableTaskDp=220 cur=1080x2424 app=1080x2424 rng=1080x1080-2424x2424
  overrideConfig={1.0 [en_US] port winConfig={ mBounds=Rect(0, 0 - 1080, 2424) mDisplayRotation=ROTATION_0 mRotation=ROTATION_0} }`

describe('parseDisplayMetrics', () => {
  it('separates the panel from what is drawn on it', () => {
    expect(parseDisplayMetrics(UNFOLDED)).toEqual({
      natural: { width: 2076, height: 2152 },
      current: { width: 2152, height: 2076 },
      rotation: 270,
    })
  })

  it('reads a folded device, where the panel changed and the rotation went back to 0', () => {
    expect(parseDisplayMetrics(FOLDED)).toEqual({
      natural: { width: 1080, height: 2424 },
      current: { width: 1080, height: 2424 },
      rotation: 0,
    })
  })

  it('reads the rotation rather than deriving it from the aspect', () => {
    // The unfolded panel is 2076x2152 — nearly square. Deriving rotation from which side is longer
    // cannot tell 0 from 180, and cannot tell 90 from 270 at all, so a derived value would be a
    // coin flip on exactly the device this exists for.
    const halfTurn = UNFOLDED.replace(/ROTATION_270/g, 'ROTATION_180')
    expect(parseDisplayMetrics(halfTurn)?.rotation).toBe(180)
  })

  it('defaults to 0 when the rotation is absent rather than guessing', () => {
    // **Stripped from the *unfolded* dump, whose rotation is 270.** Taken from the folded one it
    // proved nothing: that fixture reads 0 anyway, so "absent" and "read it" gave the same
    // answer and the default was never exercised.
    const noRot = UNFOLDED.replace(/mRotation=ROTATION_270/, '')
    expect(parseDisplayMetrics(noRot)?.rotation).toBe(0)
    // And it is still there to be read wrongly: `mDisplayRotation=ROTATION_270` survives the
    // strip, so a 270 here would mean the pattern had matched inside that longer field name.
    expect(noRot).toContain('mDisplayRotation=ROTATION_270')
  })

  it('does not read a value out of a longer field that ends in the same word', () => {
    // The dump prints `mDisplayRotation` first and they can disagree. `mDisplayRotation` ends
    // `…ayRotation`, so it does not contain `mRotation` — asserted rather than reasoned about,
    // since the whole coordinate correction hangs off which of the two is read.
    const disagree = UNFOLDED.replace(/mDisplayRotation=ROTATION_270/, 'mDisplayRotation=ROTATION_90')
    expect(parseDisplayMetrics(disagree)?.rotation).toBe(270)
  })

  it('returns null when the dump has no display line', () => {
    expect(parseDisplayMetrics('')).toBeNull()
    expect(parseDisplayMetrics('WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)')).toBeNull()
  })
})

describe('parseCornerRadius', () => {
  /** `dumpsys display` as a Pixel 9 Pro Fold prints it: both panels, whichever one is lit. */
  const DISPLAYS = `
  DisplayDeviceInfo{"Built-in Screen": uniqueId="local:4619827259835644672", 2076 x 2152, modeId 1,
    RoundedCorner{position=TopLeft, radius=85}, RoundedCorner{position=TopRight, radius=85}
  DisplayDeviceInfo{"Built-in Screen": uniqueId="local:4619827259835644673", 1080 x 2424, modeId 2,
    RoundedCorner{position=TopLeft, radius=115}, RoundedCorner{position=TopRight, radius=115}
`

  it('answers device pixels, which is the basis the caller normalises from', () => {
    // **Not a fraction.** It divided by the natural width, and the viewer multiplies by the
    // *shown* width — the same number in portrait and a different one the moment the display
    // rotates. Folded and turned, 115/1080 scaled against 2424 came out 2.24x too round.
    expect(parseCornerRadius(DISPLAYS, 1080, 2424)).toBe(115)
  })

  it('picks the panel by its size, because a foldable lists both whether lit or not', () => {
    expect(parseCornerRadius(DISPLAYS, 2076, 2152)).toBe(85)
  })

  it('answers null for a panel it does not have, leaving the caller\'s value alone', () => {
    // Null rather than 0: flattening a device's corners to square on an unrecognised reading is a
    // visible change made on no evidence.
    expect(parseCornerRadius(DISPLAYS, 1440, 3120)).toBeNull()
    expect(parseCornerRadius('', 1080, 2424)).toBeNull()
  })

  // The display's name is localised; the parser keyed on the English one read null on a Korean system (measured
  // on Galaxy_S23_API_35), and the viewer cut the screen square. A virtual display of the same size is listed first,
  // so only the `local:` filter picks the panel. Mutations: find the panel by its name again; drop the filter.
  it('finds a built-in panel whatever the system language names it', () => {
    const korean = `
  DisplayDeviceInfo{"가상 화면": uniqueId="virtual:com.example,1000,1080x2400", 1080 x 2400, modeId 1,
    RoundedCorner{position=TopLeft, radius=7}
  DisplayDeviceInfo{"기본으로 제공되는 화면": uniqueId="local:4619827259835644672", 1080 x 2400, modeId 1,
    roundedCorners RoundedCorners{[RoundedCorner{position=TopLeft, radius=104, center=Point(104, 104)
`
    expect(parseCornerRadius(korean, 1080, 2400)).toBe(104)
  })

  it('answers null for a matching panel that reports no corner', () => {
    expect(parseCornerRadius(`
  DisplayDeviceInfo{"Built-in Screen": uniqueId="local:1", 1080 x 2424, modeId 1, density 440
`, 1080, 2424)).toBeNull()
  })

  it('does not take a neighbouring panel\'s corner when the sizes are transposed', () => {
    // The natural size identifies the panel, and 2424 x 1080 is that panel rotated — not a panel
    // `dumpsys` lists. Matching it loosely would hand the cover's curve to the inner display.
    expect(parseCornerRadius(DISPLAYS, 2424, 1080)).toBeNull()
  })
})

describe('parseScreencapDisplayId', () => {
  // Cut from Pixel_9_Pro_Fold_API_37 (Android 17) captures, 2026-11-08: the panel list from the unfolded one,
  // the logical displays from each posture, every line trimmed to the fields that are read and the panel's
  // state. The panels are listed the same way in both postures; what moves is which one logical display 0
  // sits on.
  const PANELS = `Display Devices: size=2
  DisplayDeviceInfo{"Built-in Screen": uniqueId="local:4619827259835644672", 2076 x 2152, modeId 1, renderFrameRate 60.000004
  DisplayDeviceInfo{"Built-in Screen": uniqueId="local:4619827551948147201", 1080 x 2424, modeId 2, renderFrameRate 160.0
`
  const UNFOLDED = `${PANELS}  Logical Displays: size=2
  Display 0:
    mDisplayId=0
    mPrimaryDisplayDevice=Built-in Screen(local:4619827259835644672)
    mBaseDisplayInfo=DisplayInfo{"Built-in Screen", displayId 0, displayGroupId 0, FLAG_SECURE, FLAG_SUPPORTS_PROTECTED_BUFFERS, FLAG_TRUSTED, FLAG_ALLOWS_CONTENT_MODE_SWITCH, real 2076 x 2152, largest app 2076 x 2152, smallest app 2076 x 2152, rotation 0, state ON, committedState ON, type INTERNAL, uniqueId "local:4619827259835644672"}
  Display 3:
    mDisplayId=3
    mPrimaryDisplayDevice=Built-in Screen(local:4619827551948147201)
    mBaseDisplayInfo=DisplayInfo{"Built-in Screen", displayId 3, displayGroupId 0, FLAG_SECURE, FLAG_SUPPORTS_PROTECTED_BUFFERS, FLAG_TRUSTED, FLAG_ALLOWS_CONTENT_MODE_SWITCH, real 1080 x 2424, largest app 1080 x 2424, smallest app 1080 x 2424, rotation 0, state OFF, committedState OFF, type INTERNAL, uniqueId "local:4619827551948147201"}
`
  const FOLDED = `${PANELS}  Logical Displays: size=2
  Display 0:
    mDisplayId=0
    mPrimaryDisplayDevice=Built-in Screen(local:4619827551948147201)
    mBaseDisplayInfo=DisplayInfo{"Built-in Screen", displayId 0, displayGroupId 0, FLAG_SECURE, FLAG_SUPPORTS_PROTECTED_BUFFERS, FLAG_TRUSTED, FLAG_ALLOWS_CONTENT_MODE_SWITCH, real 1080 x 2424, largest app 1080 x 2424, smallest app 1080 x 2424, rotation 0, state ON, committedState ON, type INTERNAL, uniqueId "local:4619827551948147201"}
  Display 1:
    mDisplayId=1
    mPrimaryDisplayDevice=Built-in Screen(local:4619827259835644672)
    mBaseDisplayInfo=DisplayInfo{"Built-in Screen", displayId 1, displayGroupId 0, FLAG_SECURE, FLAG_SUPPORTS_PROTECTED_BUFFERS, FLAG_TRUSTED, FLAG_ALLOWS_CONTENT_MODE_SWITCH, real 2076 x 2152, largest app 2076 x 2152, smallest app 2076 x 2152, rotation 0, state OFF, committedState OFF, type INTERNAL, uniqueId "local:4619827259835644672"}
`

  it('pins the inner panel unfolded, where logical display 0 is on it', () => {
    expect(parseScreencapDisplayId(UNFOLDED)).toBe('4619827259835644672')
  })

  it('pins the cover folded, where logical display 0 has moved onto it', () => {
    // The inner panel is still listed first and is OFF — the "first display found" that an unpinned
    // `screencap` captured while folded.
    expect(parseScreencapDisplayId(FOLDED)).toBe('4619827551948147201')
  })

  it('answers null on a device with one panel, whatever else is listed', () => {
    // A virtual display (screen recording, a mirrored window) is not a panel, and must not make a phone
    // look like a foldable: `-d` with its id would capture the recording rather than the screen.
    // Mutation: count every DisplayDeviceInfo, not only the `local:` ones.
    const phone = `Display Devices: size=2
  DisplayDeviceInfo{"Built-in Screen": uniqueId="local:4619827259835644672", 1344 x 2992, modeId 1, renderFrameRate 60.000004
  DisplayDeviceInfo{"Screen recording": uniqueId="virtual:com.example,1000,1344x2992", 1344 x 2992, modeId 2,
  Logical Displays: size=2
  Display 0:
    mDisplayId=0
    mBaseDisplayInfo=DisplayInfo{"Built-in Screen", displayId 0, displayGroupId 0, real 1344 x 2992, state ON, type INTERNAL, uniqueId "local:4619827259835644672"}
`
    expect(parseScreencapDisplayId(phone)).toBeNull()
  })

  it('answers null when logical display 0 is not described, rather than picking a panel', () => {
    // Mutation: fall back to the first panel listed. That is what `screencap` does on its own, and folded
    // it is the wrong one.
    expect(parseScreencapDisplayId(PANELS)).toBeNull()
  })

  const COVER_ONLY = `  Display 3:
    mDisplayId=3
    mPrimaryDisplayDevice=Built-in Screen(local:4619827551948147201)
    mBaseDisplayInfo=DisplayInfo{"Built-in Screen", displayId 3, displayGroupId 0, FLAG_SECURE, FLAG_SUPPORTS_PROTECTED_BUFFERS, FLAG_TRUSTED, FLAG_ALLOWS_CONTENT_MODE_SWITCH, real 1080 x 2424, largest app 1080 x 2424, smallest app 1080 x 2424, rotation 0, state OFF, committedState OFF, type INTERNAL, uniqueId "local:4619827551948147201"}
`

  it('does not take another logical display for display 0', () => {
    // Every real dump lists display 0 first, so a parser that read any `displayId` would pass the fixtures
    // above. Mutation: `displayId \d+`.
    expect(parseScreencapDisplayId(`${PANELS}  Logical Displays: size=1\n${COVER_ONLY}`)).toBeNull()
  })

  it('reads display 0 wherever it is listed', () => {
    const display0 = UNFOLDED.slice(UNFOLDED.indexOf('  Display 0:'), UNFOLDED.indexOf('  Display 3:'))
    expect(parseScreencapDisplayId(`${PANELS}  Logical Displays: size=2\n${COVER_ONLY}${display0}`)).toBe('4619827259835644672')
  })
})
