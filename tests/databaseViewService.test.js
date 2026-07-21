import test from "node:test";
import assert from "node:assert/strict";

import {
  getDatabaseSummary,
  listShops,
  listHistoryEntries,
  listPresaleEntries,
} from "../src/services/databaseViewService.js";

test("getDatabaseSummary: combines counts and the DC/store breakdown into one shape", async () => {
  const repositories = {
    databaseSummary: async () => ({
      shops: { total: 10, resolved: 6, unresolved: 4 },
      history: { total: 100, distinctCustomers: 30 },
      presale: { total: 20, distinctCustomers: 15 },
    }),
    historyOverview: async () => ({
      byDc: [{ dcName: "DC_A", visits: 50, customers: 20 }],
      byStore: [{ storeName: "Store 1", dcName: "DC_A", visits: 50, customers: 20 }],
    }),
  };

  const result = await getDatabaseSummary({ repositories });
  assert.deepEqual(result, {
    shops: { total: 10, resolved: 6, unresolved: 4 },
    history: { total: 100, distinctCustomers: 30 },
    presale: { total: 20, distinctCustomers: 15 },
    byDc: [{ dcName: "DC_A", visits: 50, customers: 20 }],
    byStore: [{ storeName: "Store 1", dcName: "DC_A", visits: 50, customers: 20 }],
  });
});

test("listShops: delegates paging straight through to the repository", async () => {
  let received = null;
  const repositories = {
    listShopsPage: async (paging) => {
      received = paging;
      return { rows: [], total: 0, page: 2, pageSize: 25 };
    },
  };

  const result = await listShops({ page: 2, pageSize: 25 }, { repositories });
  assert.deepEqual(received, { page: 2, pageSize: 25 });
  assert.equal(result.page, 2);
});

test("listHistoryEntries: delegates paging straight through to the repository", async () => {
  const repositories = {
    listHistoryPage: async (paging) => ({ rows: [{ id: 1 }], total: 1, ...paging }),
  };
  const result = await listHistoryEntries({ page: 1, pageSize: 10 }, { repositories });
  assert.equal(result.rows.length, 1);
});

test("listPresaleEntries: delegates paging straight through to the repository", async () => {
  const repositories = {
    listPresalePage: async (paging) => ({ rows: [{ id: 1 }], total: 1, ...paging }),
  };
  const result = await listPresaleEntries({ page: 1, pageSize: 10 }, { repositories });
  assert.equal(result.rows.length, 1);
});
