---
"@tapflowio/android-agent": patch
---

Screenshots from an Android device with more than one display, such as the Pixel 9 Pro Fold emulator, were corrupt, and folded they showed the dark inner panel (#1118). `screencap` warned that no display was chosen, and `adb exec-out` carried that warning in front of the PNG bytes, so flow failure and last-screen screenshots, run records, MCP `screenshot` and the screenshot endpoint all returned a file that would not open. The capture is now pinned to the panel behind the display the agent streams, so a folded device shows its cover screen, and anything written before the PNG is cut off. A device with a single panel runs the same command as before.
