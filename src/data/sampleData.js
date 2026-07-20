/**
 * Sample data simulating an ERP/WMS order feed.
 *
 * In production this would come from Farmhouse's ERP/WMS (open orders,
 * delivery windows, product volumes). Here we hard-code a realistic set
 * of Bangkok-area drop points, a central depot, and a mixed fleet
 * (diesel, petrol, and EV) so CO2 comparisons are meaningful.
 *
 * `demand` is in delivery units (e.g. crates of product).
 */

// Central depot: President Bakery / Farmhouse plant area, Bangkok.
export const depot = {
  id: "DEPOT-BKK",
  name: "Farmhouse Distribution Center",
  lat: 13.7563,
  lng: 100.5018,
};

export const vehicles = [
  { id: "TRK-01", capacity: 110, fuelType: "diesel", speedKmh: 35 },
  { id: "TRK-02", capacity: 110, fuelType: "diesel", speedKmh: 35 },
  { id: "VAN-01", capacity: 60, fuelType: "petrol", speedKmh: 40 },
  { id: "EV-01", capacity: 55, fuelType: "ev", speedKmh: 40 },
];

export const orders = [
  { id: "SO-1001", customer: "7-Eleven Silom", address: "Silom Rd", demand: 12, location: { lat: 13.7248, lng: 100.5340 } },
  { id: "SO-1002", customer: "Tops Sukhumvit", address: "Sukhumvit Soi 33", demand: 18, location: { lat: 13.7300, lng: 100.5690 } },
  { id: "SO-1003", customer: "Big C Ratchadamri", address: "Ratchadamri Rd", demand: 25, location: { lat: 13.7440, lng: 100.5390 } },
  { id: "SO-1004", customer: "Lotus's Rama 4", address: "Rama IV Rd", demand: 15, location: { lat: 13.7220, lng: 100.5560 } },
  { id: "SO-1005", customer: "Villa Market Ari", address: "Phahonyothin Soi 7", demand: 10, location: { lat: 13.7790, lng: 100.5410 } },
  { id: "SO-1006", customer: "Makro Ladprao", address: "Ladprao Rd", demand: 30, location: { lat: 13.8160, lng: 100.5610 } },
  { id: "SO-1007", customer: "7-Eleven Thonglor", address: "Sukhumvit Soi 55", demand: 8, location: { lat: 13.7370, lng: 100.5820 } },
  { id: "SO-1008", customer: "Gourmet Market Emquartier", address: "Sukhumvit Rd", demand: 14, location: { lat: 13.7300, lng: 100.5700 } },
  { id: "SO-1009", customer: "Tops Chaeng Wattana", address: "Chaeng Wattana Rd", demand: 22, location: { lat: 13.8850, lng: 100.5490 } },
  { id: "SO-1010", customer: "Big C Bangna", address: "Bangna-Trat Rd", demand: 28, location: { lat: 13.6680, lng: 100.6040 } },
  { id: "SO-1011", customer: "Lotus's Rama 3", address: "Rama III Rd", demand: 16, location: { lat: 13.6930, lng: 100.5410 } },
  { id: "SO-1012", customer: "7-Eleven Victory Monument", address: "Ratchawithi Rd", demand: 9, location: { lat: 13.7650, lng: 100.5370 } },
  { id: "SO-1013", customer: "Makro Sathorn", address: "Sathorn Rd", demand: 20, location: { lat: 13.7180, lng: 100.5290 } },
  { id: "SO-1014", customer: "Villa Market Phrom Phong", address: "Sukhumvit Soi 24", demand: 11, location: { lat: 13.7290, lng: 100.5690 } },
  { id: "SO-1015", customer: "Tops Pinklao", address: "Borommaratchachonnani Rd", demand: 17, location: { lat: 13.7770, lng: 100.4770 } },
];

export function getScenario() {
  return {
    depot: { lat: depot.lat, lng: depot.lng, id: depot.id, name: depot.name },
    vehicles: vehicles.map((v) => ({ ...v })),
    orders: orders.map((o) => ({ ...o })),
  };
}
