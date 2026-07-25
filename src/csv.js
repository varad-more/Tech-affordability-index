/**
 * Minimal RFC-4180 field splitter.
 *
 * Worth its own module because getting this wrong is silent: ZORI quotes metro
 * names as `"New York, NY"`, so a naive `split(',')` shifts every subsequent
 * column by one and yields plausible-looking numbers from the wrong month.
 */
export function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }

  fields.push(field);
  return fields;
}
