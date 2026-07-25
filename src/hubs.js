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
 *
 * `cbsa` is the Census CBSA code for the metropolitan statistical area. It is
 * the join key into the MIT Living Wage Calculator, which is addressed by CBSA
 * (`/metros/{cbsa}`). Verified against BEA's metropolitan-area table, which
 * publishes the same codes with their full official names.
 *
 * `lat` / `lon` place the metro's principal city on the map. These locate a dot,
 * nothing more — no figure on the page is computed from them.
 */

export const HUBS = [
  { id: 'sf',  city: 'San Francisco',  zoriRegion: 'San Francisco, CA',  state: 'CA', local: null,  cbsa: '41860', lat: 37.77, lon: -122.42 },
  { id: 'sjc', city: 'San Jose',       zoriRegion: 'San Jose, CA',       state: 'CA', local: null,  cbsa: '41940', lat: 37.34, lon: -121.89 },
  { id: 'la',  city: 'Los Angeles',    zoriRegion: 'Los Angeles, CA',    state: 'CA', local: null,  cbsa: '31080', lat: 34.05, lon: -118.24 },
  { id: 'sd',  city: 'San Diego',      zoriRegion: 'San Diego, CA',      state: 'CA', local: null,  cbsa: '41740', lat: 32.72, lon: -117.16 },
  { id: 'sea', city: 'Seattle',        zoriRegion: 'Seattle, WA',        state: 'WA', local: null,  cbsa: '42660', lat: 47.61, lon: -122.33 },
  { id: 'nyc', city: 'New York',       zoriRegion: 'New York, NY',       state: 'NY', local: 'NYC', cbsa: '35620', lat: 40.71, lon: -74.01 },
  { id: 'bos', city: 'Boston',         zoriRegion: 'Boston, MA',         state: 'MA', local: null,  cbsa: '14460', lat: 42.36, lon: -71.06 },
  { id: 'aus', city: 'Austin',         zoriRegion: 'Austin, TX',         state: 'TX', local: null,  cbsa: '12420', lat: 30.27, lon: -97.74 },
  { id: 'dal', city: 'Dallas',         zoriRegion: 'Dallas, TX',         state: 'TX', local: null,  cbsa: '19100', lat: 32.78, lon: -96.80 },
  { id: 'den', city: 'Denver',         zoriRegion: 'Denver, CO',         state: 'CO', local: null,  cbsa: '19740', lat: 39.74, lon: -104.99 },
  { id: 'chi', city: 'Chicago',        zoriRegion: 'Chicago, IL',        state: 'IL', local: null,  cbsa: '16980', lat: 41.88, lon: -87.63 },
  { id: 'atl', city: 'Atlanta',        zoriRegion: 'Atlanta, GA',        state: 'GA', local: null,  cbsa: '12060', lat: 33.75, lon: -84.39 },
  { id: 'rdu', city: 'Raleigh',        zoriRegion: 'Raleigh, NC',        state: 'NC', local: null,  cbsa: '39580', lat: 35.78, lon: -78.64 },
  { id: 'pdx', city: 'Portland',       zoriRegion: 'Portland, OR',       state: 'OR', local: null,  cbsa: '38900', lat: 45.52, lon: -122.68 },
  { id: 'phx', city: 'Phoenix',        zoriRegion: 'Phoenix, AZ',        state: 'AZ', local: null,  cbsa: '38060', lat: 33.45, lon: -112.07 },
  { id: 'slc', city: 'Salt Lake City', zoriRegion: 'Salt Lake City, UT', state: 'UT', local: null,  cbsa: '41620', lat: 40.76, lon: -111.89 },
  { id: 'mia', city: 'Miami',          zoriRegion: 'Miami, FL',          state: 'FL', local: null,  cbsa: '33100', lat: 25.76, lon: -80.19 },
  { id: 'bna', city: 'Nashville',      zoriRegion: 'Nashville, TN',      state: 'TN', local: null,  cbsa: '34980', lat: 36.16, lon: -86.78 },
  { id: 'msp', city: 'Minneapolis',    zoriRegion: 'Minneapolis, MN',    state: 'MN', local: null,  cbsa: '33460', lat: 44.98, lon: -93.27 },
  {
    id: 'phl',
    city: 'Philadelphia',
    zoriRegion: 'Philadelphia, PA',
    state: 'PA',
    local: 'PHL',
    cbsa: '37980',
    lat: 39.95,
    lon: -75.17,
  },
  {
    id: 'dc',
    city: 'Washington, DC',
    zoriRegion: 'Washington, DC',
    // The MSA spans DC, Maryland and Virginia. Modelled as Northern Virginia,
    // where the bulk of the region's tech employment sits.
    state: 'VA',
    local: null,
    cbsa: '47900',
    lat: 38.91,
    lon: -77.04,
    note: 'Modelled as Northern Virginia; the metro also spans DC and Maryland, which tax differently.',
  },
];

export const HUB_BY_ID = Object.fromEntries(HUBS.map((h) => [h.id, h]));
