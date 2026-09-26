/**
 * Starts loading KaTeX's main faces as soon as its stylesheet is in, so the
 * first frame with math doesn't wait for them (or show a fallback face
 * whose metrics differ).
 */
export function warmMathFonts(): void {
  if (!document.fonts?.load) return;
  for (const font of ["1em KaTeX_Main", "italic 1em KaTeX_Math", "1em KaTeX_Size2"]) {
    void document.fonts.load(font).catch(() => {});
  }
}
