/**
 * Shared motion utility — see /design.md "Motion" section.
 *
 * `countUp` is the one JS-driven motion primitive the design system adds
 * (everything else is CSS animation/transition). It animates a metric card's
 * displayed number from 0 up to its real value on every render — the "alive"
 * moment every dashboard page gets. Respects `prefers-reduced-motion`.
 */

const REDUCED_MOTION = () =>
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Animate `el`'s text content counting up to `text`'s numeric value.
 * Parses a leading number (handles thousands separators, decimals, a
 * trailing unit like "%" or " min"); non-numeric text is set immediately,
 * no animation. Always lands on the exact original string, so no float
 * rounding drift from the eased interpolation survives the final frame.
 *
 * @param {HTMLElement} el
 * @param {string|number} text
 * @param {{ duration?: number }} [options]
 */
export function countUp(el, text, { duration = 700 } = {}) {
  const str = text == null ? "" : String(text);
  const match = str.match(/^-?[\d,]+(\.\d+)?/);

  if (!match || REDUCED_MOTION()) {
    el.textContent = str;
    return;
  }

  const target = Number(match[0].replace(/,/g, ""));
  if (!Number.isFinite(target)) {
    el.textContent = str;
    return;
  }

  const suffix = str.slice(match[0].length);
  const decimals = match[1] ? match[1].length - 1 : 0;
  const start = performance.now();
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const value = target * easeOutCubic(t);
    el.textContent = `${value.toFixed(decimals)}${suffix}`;
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      el.textContent = str;
    }
  }

  requestAnimationFrame(frame);
}
