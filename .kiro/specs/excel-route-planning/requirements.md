# Requirements Document

## Introduction

This feature extends the existing Farmhouse (Saha Group) route-optimization prototype with the ability to ingest three Excel workbooks and build three route-planning capabilities on top of them:

1. **History comparison** — process historical sales/delivery data and compare the original (historical) route order against a new AI-optimized order, showing an estimated delivery time per customer, with filtering on history columns.
2. **Presale re-planning** — build and optimize a route from the customer list in the Presale workbook, with filtering.
3. **Driver app** — a mobile-friendly view that lets a driver follow the AI-optimized stop order, with per-stop handoff links into Google Maps for turn-by-turn navigation.

The feature reuses the existing CVRP optimizer (`src/optimizer/`), pluggable routing layer (`src/routing/router.js`), ETA service (`src/services/etaService.js`), plan orchestration (`src/services/routeService.js`), REST API (`src/routes/api.js`), and Leaflet dashboard (`public/`). It adds an Excel ingestion layer and three new capabilities layered on the current `{ id, customer, demand, location:{lat,lng} }` order model.

Shops are matched across workbooks by customer code: History `Customer_Code`, Master `Customer_code`, and the `Customer_Code` embedded in the Presale `CustomerName` field (a concatenation of code and name). Coordinates and service/working-time data come from the Shop_Master; when a shop lacks coordinates there, they are resolved via the Longdo Map geocoding API.

## Glossary

- **Ingestion_Service**: The component that reads an uploaded Excel workbook, validates it, and maps rows into internal records (orders, shops, history entries).
- **History_Workbook**: The uploaded `farmhouse route history.xlsx` containing historical sales/delivery time records.
- **Shop_Master**: The uploaded `Master_FH_shops.xlsx` containing shop reference data including session duration and working time.
- **Presale_Workbook**: The uploaded `Presale.xlsx` listing future shops to be delivered to.
- **History_Comparison**: The capability that produces a side-by-side comparison of the historical visit order and the AI-optimized visit order for a selected set of history records.
- **Presale_Plan**: An optimized delivery plan generated from the Presale customer list.
- **Driver_View**: The mobile-friendly interface a driver uses to follow the optimized stop order.
- **Optimizer**: The existing CVRP solver (`src/optimizer/vrp.js`) that orders stops via nearest-neighbour plus 2-opt.
- **Routing_Layer**: The existing pluggable router (`src/routing/router.js`) that reports per-leg distance and travel time (estimator or Longdo).
- **ETA_Service**: The existing service (`src/services/etaService.js`) that derives per-stop estimated arrival times from leg metrics, speed, and service time.
- **Stop**: A single delivery location in a route, with a sequence position, customer identity, coordinates, demand, and ETA.
- **Session_Duration**: The time a driver is expected to spend serving a shop (per-stop service time).
- **Working_Time**: The time window during which a shop can receive deliveries.
- **Filter**: A user-specified set of criteria that narrows which records feed a capability, keyed on the shared columns `DC_Name`, `StoreName`, `DELIVERY_DATE`, `StoreGroup`, `Store Area`, and `CustomerType`.
- **Google_Maps_Link**: A URL that opens Google Maps navigation to a stop's coordinates or address.
- **Customer_Code**: The shop identifier that joins the three workbooks (History `Customer_Code`, Master `Customer_code`, and the code prefix inside Presale `CustomerName`).
- **Longdo_Geocoder**: The Longdo Map API used to resolve coordinates for a shop that has no `lat`/`long` in the Shop_Master.

### Workbook Column Reference

**History_Workbook (`farmhouse route history.xlsx`)**: `Customer_Code` (shop id), `Customer_Name`, `DC_Name` (distribution center), `StoreName` (driver/sales unit), `InvoiceDate` (delivered date), `TIME_VISIT` (delivery timestamp), `VISIT_TYPE` (monthly visit schedule), `StoreGroup`, `Store Area` (region), `CustomerType`, `จำนวนลง` (delivery quantity).

**Presale_Workbook (`Presale.xlsx`)**: `CustomerName` (concatenation of `Customer_Code` and customer name), `DELIVERY_DATE` (scheduled delivery date), `จำนวน Presale` (presale order quantity). Other columns are out of scope.

**Shop_Master (`Master_FH_shops.xlsx`)**: `Customer_code` (shop id), `shop_name`, `lat`, `long`, `service_time_min` (per-stop service duration in minutes), `open_time`, `close_time`, `วันเข้าร้าน` (detailed visit type). `parking_group_id` and `shop_type` are out of scope.

## Requirements

### Requirement 1: Upload and parse the three Excel workbooks

**User Story:** As a dispatch planner, I want to upload the history, shop master, and presale Excel files, so that the system can plan routes from real Farmhouse data instead of hard-coded samples.

#### Acceptance Criteria

1. WHEN a user uploads a workbook classified as History, Shop_Master, or Presale, THE Ingestion_Service SHALL parse the first worksheet into structured rows.
2. WHEN a workbook is parsed, THE Ingestion_Service SHALL return the count of rows read and the list of detected column headers.
3. IF an uploaded file is not a readable `.xlsx` workbook, THEN THE Ingestion_Service SHALL reject the upload and return a descriptive error message identifying the problem.
4. IF a required column for the workbook type is absent, THEN THE Ingestion_Service SHALL reject the workbook and return an error naming each missing required column, WHERE the required columns are: History (`Customer_Code`, `TIME_VISIT`, `จำนวนลง`), Shop_Master (`Customer_code`, `lat`, `long`, `service_time_min`, `open_time`, `close_time`), and Presale (`CustomerName`, `DELIVERY_DATE`, `จำนวน Presale`).
5. WHERE a row is missing values in a required column, THE Ingestion_Service SHALL exclude that row from the mapped result and record the excluded row number in a warnings list.
6. WHEN some rows are excluded due to missing required values, THE Ingestion_Service SHALL continue mapping the remaining valid rows into shop records.
7. IF recording an exclusion warning fails, THEN THE Ingestion_Service SHALL continue processing the remaining rows.
8. THE Ingestion_Service SHALL map Shop_Master rows into shop records that include a shop identifier, coordinates, Session_Duration, and Working_Time.

### Requirement 2: Resolve shop coordinates for mapping and navigation

**User Story:** As a dispatch planner, I want every shop to have latitude and longitude, so that the optimizer can order stops and the driver app can hand off to Google Maps.

#### Acceptance Criteria

1. WHERE a Shop_Master row provides numeric `lat` and `long`, THE Ingestion_Service SHALL use those coordinates directly for the shop.
2. WHERE a Shop_Master row has no usable `lat`/`long`, THE Ingestion_Service SHALL resolve coordinates for that shop using the Longdo_Geocoder.
3. IF coordinates cannot be resolved for a shop, THEN THE Ingestion_Service SHALL exclude that shop from routing AND record the shop identifier in a warnings list as two separate mandatory steps.
4. WHERE resolved coordinates fall on suspicious values such as latitude 0 and longitude 0, THE Ingestion_Service SHALL treat the shop as unresolved and exclude it from routing.
5. WHEN a shop identifier appears in both a Presale_Workbook and the Shop_Master, THE Ingestion_Service SHALL use the Shop_Master coordinates, Session_Duration, and Working_Time for that shop.

### Requirement 3: Compare historical route order against the AI-optimized order

**User Story:** As a logistics manager, I want to compare the original delivery order from history against a newly optimized order, so that I can quantify the improvement and see the estimated delivery time per customer.

#### Acceptance Criteria

1. WHEN a user requests a History_Comparison for a selected set of History_Workbook records, THE History_Comparison SHALL derive the historical visit order from the delivery timestamps in those records.
2. WHEN a History_Comparison is produced, THE Optimizer SHALL generate a new optimized visit order for the same set of customers.
3. WHEN a History_Comparison is produced, THE ETA_Service SHALL compute an estimated delivery time for each customer in both the historical order and the optimized order.
4. WHEN a History_Comparison is produced, THE History_Comparison SHALL report, for each customer, the historical sequence position, the optimized sequence position, and both estimated delivery times.
5. WHEN a History_Comparison is produced, THE History_Comparison SHALL report the total distance of the historical order and the total distance of the optimized order.
6. IF the selected set of records contains exactly one customer, THEN THE History_Comparison SHALL return a message stating that a comparison requires at least two customers.
7. IF the selected set of records contains zero customers, THEN THE History_Comparison SHALL return a message stating that no records were selected.

### Requirement 4: Filter history records before comparison

**User Story:** As a logistics manager, I want to filter the history data before comparing, so that I can analyze a specific route, day, or salesperson.

#### Acceptance Criteria

1. WHERE a user supplies filter criteria on any of `DC_Name`, `StoreName`, `StoreGroup`, `Store Area`, or `CustomerType`, THE History_Comparison SHALL include only records matching all supplied criteria.
2. WHERE a `DELIVERY_DATE` range filter is supplied, THE History_Comparison SHALL include only records whose delivered date falls within the inclusive range.
3. WHEN no filter criteria are supplied, THE History_Comparison SHALL include all parsed History_Workbook records.
4. IF the applied filter matches no records, THEN THE History_Comparison SHALL return an empty result set with a message stating that no records matched.

### Requirement 5: Build and optimize a route from the Presale customer list

**User Story:** As a dispatch planner, I want to generate an optimized route from the presale orders, so that drivers deliver future orders in an efficient sequence.

#### Acceptance Criteria

1. WHEN a user requests a Presale_Plan, THE Ingestion_Service SHALL parse the `Customer_Code` prefix out of each Presale `CustomerName`, join it to the Shop_Master by `Customer_code`, and convert the result into orders using the `{ id, customer, demand, location:{lat,lng} }` shape consumed by the Optimizer, using `จำนวน Presale` as demand.
2. WHEN a Presale_Plan is requested, THE Optimizer SHALL produce an optimized stop order for the presale customers, respecting vehicle capacity.
3. WHEN a Presale_Plan is produced, THE ETA_Service SHALL compute an estimated delivery time for each stop.
4. WHERE Shop_Master data is available for a presale customer, THE Optimizer SHALL use that customer's `service_time_min` as the per-stop service time.
5. IF a presale customer cannot be matched to coordinates, THEN THE Presale_Plan SHALL list that customer as unassigned with the reason, regardless of whether Shop_Master data is available for that customer.

### Requirement 6: Filter presale customers before planning

**User Story:** As a dispatch planner, I want to filter the presale list before planning, so that I can plan a route for a specific region, vehicle, or delivery day.

#### Acceptance Criteria

1. WHERE a user supplies filter criteria on any of `DC_Name`, `StoreName`, `DELIVERY_DATE`, `StoreGroup`, `Store Area`, or `CustomerType` (drawn from the Presale row or the joined Shop_Master/History data), THE Presale_Plan SHALL include only customers matching all supplied criteria.
2. WHEN no filter criteria are supplied, THE Presale_Plan SHALL include all parsed Presale_Workbook customers.
3. IF the applied filter matches no customers, THEN THE Presale_Plan SHALL return a message stating that no customers matched.

### Requirement 7: Respect shop working time and session duration in planning

**User Story:** As a dispatch planner, I want the plan to account for each shop's working time and session duration, so that deliveries arrive when shops can receive them.

#### Acceptance Criteria

1. WHERE a shop defines an `open_time`/`close_time` window, THE Presale_Plan SHALL flag any stop whose estimated delivery time falls outside that window as a time-window violation.
2. WHERE a shop defines `service_time_min`, THE ETA_Service SHALL add that duration as the service time after arrival at that stop.
3. WHERE a shop does not define `service_time_min`, THE ETA_Service SHALL apply the existing default service time.

### Requirement 8: Driver view to follow the optimized route

**User Story:** As a delivery driver, I want a mobile-friendly view of my single assigned optimized stop order, so that I can visit customers in the recommended sequence.

#### Acceptance Criteria

1. WHEN an authenticated driver opens the Driver_View, THE Driver_View SHALL display that driver's single assigned route with its stops in optimized sequence order, showing customer name and estimated delivery time.
2. THE Driver_View SHALL render in a layout usable on a mobile-sized screen.
3. WHEN a driver marks a stop as completed, THE Driver_View SHALL advance the highlighted current stop to the next uncompleted stop.
4. WHERE a plan contains no stops, THE Driver_View SHALL display a message stating that there are no stops to deliver, and SHALL only display that message when the plan contains no stops.
5. IF the empty-plan message cannot be displayed, THEN THE Driver_View SHALL display fallback content indicating the plan could not be loaded.

### Requirement 9: Google Maps navigation handoff

**User Story:** As a delivery driver, I want each stop to link into Google Maps, so that I get turn-by-turn navigation to the customer.

#### Acceptance Criteria

1. WHEN the Driver_View renders a stop with coordinates, THE Driver_View SHALL provide a Google_Maps_Link that opens navigation to that stop's latitude and longitude.
2. WHERE a stop has an address but no coordinates, THE Driver_View SHALL provide a Google_Maps_Link that opens navigation to that address.
3. WHEN a driver activates a Google_Maps_Link, THE Driver_View SHALL open the link in a new context so the Driver_View remains available.
4. IF a Google_Maps_Link cannot be generated for a stop, THEN THE Driver_View SHALL display the stop's coordinates or address as fallback navigation information.

### Requirement 10: Driver authentication

**User Story:** As a delivery driver, I want to log in with my employee credentials, so that I see only my own assigned route.

#### Acceptance Criteria

1. WHEN a driver submits a valid employee username and password, THE Driver_View SHALL authenticate the driver and grant access to that driver's assigned route.
2. IF a driver submits invalid credentials, THEN THE Driver_View SHALL deny access and return an authentication error without revealing which field was incorrect.
3. WHILE a driver is not authenticated, THE Driver_View SHALL withhold all route and stop information.
