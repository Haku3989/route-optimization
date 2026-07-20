/**
 * CO2 emission estimates for the fleet.
 *
 * One of the workshop success metrics is reducing CO2. We compare an
 * optimized plan against a naive baseline (orders served in the order
 * they arrive) to quantify the saving.
 *
 * Emission factors are approximate averages (kg CO2 per km):
 *   - diesel light truck:  ~0.27
 *   - petrol van:          ~0.19
 *   - electric van (EV):   ~0.05  (well-to-wheel from grid electricity)
 */

export const EMISSION_FACTORS_KG_PER_KM = {
  diesel: 0.27,
  petrol: 0.19,
  ev: 0.05,
};

export function emissionFactorFor(vehicle) {
  const type = (vehicle?.fuelType || "diesel").toLowerCase();
  return EMISSION_FACTORS_KG_PER_KM[type] ?? EMISSION_FACTORS_KG_PER_KM.diesel;
}

/**
 * CO2 in kilograms for a given distance and vehicle.
 */
export function co2ForDistance(distanceKm, vehicle) {
  return distanceKm * emissionFactorFor(vehicle);
}
