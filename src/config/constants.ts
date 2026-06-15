// src/config/constants.ts

// ─── Airport Fixed Location ───────────────────────────────────────────────────
// All rides originate from this single airport.
// Chandigarh Airport coordinates.
export const AIRPORT_LAT = 30.6942;
export const AIRPORT_LNG = 76.8606;

// ─── Pooling Window ───────────────────────────────────────────────────────────
// A pool stays in "forming" state for this many seconds.
// Any ride request that arrives within this window can be added to the pool.
// After 90s, the pool is confirmed and closed to new additions.
export const POOL_WINDOW_SECONDS = 90;

// ─── How many active pools the pooling algorithm checks per new ride ──────────
// We don't scan ALL forming pools — just the 5 oldest ones (oldest = waited longest).
// Keeps the algorithm fast. In practice p <= 5, k <= 4 → ~80 ops max.
export const MAX_POOLS_TO_CHECK = 5;

// ─── Pricing Constants ────────────────────────────────────────────────────────
// Base cost per km of actual route distance the passenger travels.
export const BASE_RATE_PER_KM = 12; // ₹ per km

// Flat surcharge per piece of luggage.
export const LUGGAGE_RATE = 20; // ₹ per bag

// For every 1% detour a passenger accepts, their fare increases by 0.5%.
// This discourages passengers from gaming the system by setting huge detour tolerance.
export const DETOUR_PENALTY_RATE = 0.005; // 0.5% fare increase per 1% detour

// Surge pricing cap — fare never exceeds 2x the normal price regardless of demand.
export const MAX_DEMAND_MULTIPLIER = 2.0;