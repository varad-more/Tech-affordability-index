/**
 * The one line in the footer that is not static text.
 *
 * The site's whole claim is that its numbers are current, so the footer says
 * which month the rent data is from rather than asserting freshness in the
 * abstract. It reads the same committed file the pages do — the browser serves
 * it from cache on the two pages that have already fetched it — and falls back
 * to the cadence, which stays true whether or not the fetch succeeds.
 */
import { dataUrl } from './data.js';

export async function initFooter() {
  const node = document.getElementById('footer-freshness');
  if (!node) return;

  const cadence = 'Checked weekly against Zillow.';

  try {
    const rents = await fetch(dataUrl('rents.json')).then((r) => r.json());
    const month = new Date(`${rents.asOf}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    node.innerHTML =
      `<span class="dot" aria-hidden="true"></span>Rent data current to ${month}. ${cadence}`;
  } catch {
    node.innerHTML = `<span class="dot" aria-hidden="true"></span>${cadence}`;
  }
}
