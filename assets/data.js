/**
 * Where the data files live, resolved against this module rather than the page.
 *
 * Pages sit at /, /states/, /timing/ and /method/, so a plain relative fetch
 * would mean a different thing on each one. Every script that needs data is
 * under /assets/, so resolving from here gives one answer everywhere.
 */
export const dataUrl = (name) => new URL(`../data/${name}`, import.meta.url);
