// Builds data/cities.tsv from the GeoNames-derived `all-the-cities` npm package.
// Usage: npm i --no-save all-the-cities@3.1.0 && node scripts/build-cities.js
const fs = require('fs');
const path = require('path');
const cities = require('all-the-cities');

const MIN_POPULATION = 5000;
// Skip city sections, historical/abandoned/destroyed places.
const SKIP_CODES = new Set(['PPLX', 'PPLH', 'PPLQ', 'PPLW', 'PPLCH']);

const rows = cities
  .filter(c => c.population >= MIN_POPULATION && !SKIP_CODES.has(c.featureCode))
  .sort((a, b) => b.population - a.population)
  .map(c => {
    const [lon, lat] = c.loc.coordinates;
    const name = c.name.replace(/[\t\n]/g, ' ');
    return `${name}\t${c.country}\t${lat.toFixed(3)}\t${lon.toFixed(3)}\t${c.population}`;
  });

const out = path.join(__dirname, '..', 'data', 'cities.tsv');
fs.writeFileSync(out, rows.join('\n') + '\n');
console.log(`Wrote ${rows.length} places to ${out}`);
