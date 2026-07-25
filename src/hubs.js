/**
 * The tech hubs this index tracks.
 *
 * `zoriRegion` must match Zillow's `RegionName` exactly — the ingest fails loudly
 * if one goes missing rather than quietly dropping a city.
 *
 * `state` is deliberately curated, NOT taken from the CSV's `StateName` column.
 * Zillow reports one primary state per metro, and it is wrong for tax purposes on
 * multi-state MSAs: the Washington, DC metro is listed under `VA`, and the New
 * York metro spans NY/NJ/CT. Getting this from a lookup nobody reviewed would
 * silently mis-tax entire cities.
 */

export const HUBS = [
  { id: 'sf',      city: 'San Francisco', zoriRegion: 'San Francisco, CA',  state: 'CA', local: null },
  { id: 'sjc',     city: 'San Jose',      zoriRegion: 'San Jose, CA',       state: 'CA', local: null },
  { id: 'la',      city: 'Los Angeles',   zoriRegion: 'Los Angeles, CA',    state: 'CA', local: null },
  { id: 'sd',      city: 'San Diego',     zoriRegion: 'San Diego, CA',      state: 'CA', local: null },
  { id: 'sea',     city: 'Seattle',       zoriRegion: 'Seattle, WA',        state: 'WA', local: null },
  { id: 'nyc',     city: 'New York',      zoriRegion: 'New York, NY',       state: 'NY', local: 'NYC' },
  { id: 'bos',     city: 'Boston',        zoriRegion: 'Boston, MA',         state: 'MA', local: null },
  { id: 'aus',     city: 'Austin',        zoriRegion: 'Austin, TX',         state: 'TX', local: null },
  { id: 'dal',     city: 'Dallas',        zoriRegion: 'Dallas, TX',         state: 'TX', local: null },
  { id: 'den',     city: 'Denver',        zoriRegion: 'Denver, CO',         state: 'CO', local: null },
  { id: 'chi',     city: 'Chicago',       zoriRegion: 'Chicago, IL',        state: 'IL', local: null },
  { id: 'atl',     city: 'Atlanta',       zoriRegion: 'Atlanta, GA',        state: 'GA', local: null },
  { id: 'rdu',     city: 'Raleigh',       zoriRegion: 'Raleigh, NC',        state: 'NC', local: null },
  { id: 'pdx',     city: 'Portland',      zoriRegion: 'Portland, OR',       state: 'OR', local: null },
  { id: 'phx',     city: 'Phoenix',       zoriRegion: 'Phoenix, AZ',        state: 'AZ', local: null },
  { id: 'slc',     city: 'Salt Lake City',zoriRegion: 'Salt Lake City, UT', state: 'UT', local: null },
  { id: 'mia',     city: 'Miami',         zoriRegion: 'Miami, FL',          state: 'FL', local: null },
  { id: 'bna',     city: 'Nashville',     zoriRegion: 'Nashville, TN',      state: 'TN', local: null },
  { id: 'msp',     city: 'Minneapolis',   zoriRegion: 'Minneapolis, MN',    state: 'MN', local: null },
  {
    id: 'phl',
    city: 'Philadelphia',
    zoriRegion: 'Philadelphia, PA',
    state: 'PA',
    local: 'PHL',
  },
  {
    id: 'dc',
    city: 'Washington, DC',
    zoriRegion: 'Washington, DC',
    // The MSA spans DC, Maryland and Virginia. Modelled as Northern Virginia,
    // where the bulk of the region's tech employment sits.
    state: 'VA',
    local: null,
    note: 'Modelled as Northern Virginia; the metro also spans DC and Maryland, which tax differently.',
  },
];

export const HUB_BY_ID = Object.fromEntries(HUBS.map((h) => [h.id, h]));
