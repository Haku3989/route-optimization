/**
 * Shared early/on-time/late classification, used by both the admin daily
 * delivery report (historical Excel data) and the driver live completion
 * tracking (real-time). Kept as its own tiny pure module so the definition of
 * "on time" can't drift between the two.
 */

/** Deviation (in minutes) from the scheduled/optimized ETA still counted as "on time". */
export const ON_TIME_TOLERANCE_MIN = 15;

/**
 * Classify a deviation from a scheduled/optimized ETA.
 * Positive `deviationMin` means later than scheduled (late); negative means
 * earlier (early). The boundary at exactly `ON_TIME_TOLERANCE_MIN` is
 * inclusive on the "on_time" side, mirroring `etaService.checkWindow`'s
 * inclusive-range convention.
 *
 * @param {number|null|undefined} deviationMin
 * @returns {"early"|"on_time"|"late"|null} null when there is nothing to classify
 */
export function classifyDeviation(deviationMin) {
  if (deviationMin == null || !Number.isFinite(deviationMin)) return null;
  if (deviationMin < -ON_TIME_TOLERANCE_MIN) return "early";
  if (deviationMin > ON_TIME_TOLERANCE_MIN) return "late";
  return "on_time";
}
