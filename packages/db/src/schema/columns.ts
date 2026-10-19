import { customType } from 'drizzle-orm/pg-core';

/**
 * timestamptz that always surfaces as an ISO-8601 string. Drizzle's
 * node-postgres driver forces raw text for timestamps (e.g. "2026-02-28 12:00:00+00");
 * API contracts promise ISO strings, so normalize at the column boundary.
 */
export const timestamptz = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'timestamp with time zone';
  },
  fromDriver(value: string) {
    return new Date(value).toISOString();
  },
  toDriver(value: string) {
    return value;
  },
});
