/**
 * Database viewer service — read-only aggregate summary and paginated raw-row
 * browsing over the three uploaded workbooks' tables (shops, history_entries,
 * presale_entries), for the admin "Database" page.
 *
 * Thin passthroughs to the repository layer (all the real logic — pagination
 * bounds, aggregation SQL — lives there); kept here only for the same
 * dependency-injection seam every other service uses (`deps.repositories`),
 * so tests never touch a database.
 */

import * as realRepositories from "../db/repositories.js";

/**
 * Aggregate counts + resolution stats + the DC/store breakdown (reused from
 * `historyOverview`) — one call for the whole summary panel.
 *
 * @param {{ repositories?: object }} [deps]
 */
export async function getDatabaseSummary(deps = {}) {
  const repositories = deps.repositories || realRepositories;
  const [counts, overview] = await Promise.all([
    repositories.databaseSummary(),
    repositories.historyOverview(),
  ]);
  return { ...counts, byDc: overview.byDc, byStore: overview.byStore };
}

/** @param {{ page?:number, pageSize?:number }} [paging] @param {{ repositories?: object }} [deps] */
export async function listShops(paging = {}, deps = {}) {
  const repositories = deps.repositories || realRepositories;
  return repositories.listShopsPage(paging);
}

/** @param {{ page?:number, pageSize?:number }} [paging] @param {{ repositories?: object }} [deps] */
export async function listHistoryEntries(paging = {}, deps = {}) {
  const repositories = deps.repositories || realRepositories;
  return repositories.listHistoryPage(paging);
}

/** @param {{ page?:number, pageSize?:number }} [paging] @param {{ repositories?: object }} [deps] */
export async function listPresaleEntries(paging = {}, deps = {}) {
  const repositories = deps.repositories || realRepositories;
  return repositories.listPresalePage(paging);
}
