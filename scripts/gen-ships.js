'use strict';

/**
 * Hutengeneza picha 13 za meli kwa viwango vya uwekezaji.
 * Matokeo: public/img/ships/level-1.svg ... level-13.svg
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'img', 'ships');

const PALETTES = [
  { sky: ['#eaf7ef', '#c8ecdb'], hull: '#0f7a45', deck: '#0a5c34', accent: '#d4af37', cargo: '#1f9d61' },
  { sky: ['#eef8f2', '#bfe6d3'], hull: '#116b3f', deck: '#0b4f2e', accent: '#e0bb45', cargo: '#2aa76a' },
  { sky: ['#e9f6f1', '#b5e0cb'], hull: '#0d6b46', deck: '#08492f', accent: '#d4af37', cargo: '#178a55' },
  { sky: ['#f0f9f4', '#cbe9d8'], hull: '#14704a', deck: '#0c5233', accent: '#c9a227', cargo: '#25a06a' },
  { sky: ['#eaf7f0', '#c2e5d2'], hull: '#0b5f3c', deck: '#07432a', accent: '#e6c34a', cargo: '#1e9159' },
  { sky: ['#eff8f3', '#bfe3d1'], hull: '#126c46', deck: '#0a4d30', accent: '#d8b53c', cargo: '#2ba46d' },
  { sky: ['#e8f6ef', '#b9dfcb'], hull: '#0e6a44', deck: '#08462c', accent: '#d4af37', cargo: '#1b8f58' },
  { sky: ['#f1f9f5', '#c6e7d6'], hull: '#157049', deck: '#0d5434', accent: '#cfae2f', cargo: '#27a26c' },
  { sky: ['#eaf7f1', '#bde2cf'], hull: '#0c6440', deck: '#08472c', accent: '#dcc049', cargo: '#209159' },
  { sky: ['#eef8f4', '#c3e5d5'], hull: '#136d47', deck: '#0b5032', accent: '#d4af37', cargo: '#2aa26c' },
  { sky: ['#e9f6f2', '#b7e0cd'], hull: '#0f6842', deck: '#094a2d', accent: '#e3c04a', cargo: '#1d8f59' },
  { sky: ['#f0f9f5', '#c8e8d8'], hull: '#14714b', deck: '#0c5536', accent: '#d4af37', cargo: '#28a26b' },
  { sky: ['#f4fbf7', '#cfeade'], hull: '#0a5a39', deck: '#063f27', accent: '#f0c94a', cargo: '#19915a' },
];

// Aina za meli: 0 cargo, 1 container, 2 tanker, 3 ferry, 4 bulk
function shipFor(level) {
  return level % 5;
}

function containers(x, y, palette, count) {
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const cx = x + i * 34;
    out += `<rect x="${cx}" y="${y}" width="30" height="16" rx="2" fill="${i % 2 ? palette.accent : palette.cargo}" opacity="0.92"/>`;
    out += `<rect x="${cx + 3}" y="${y + 3}" width="24" height="3" rx="1.5" fill="#ffffff" opacity="0.28"/>`;
    if (i < count - 1) {
      out += `<rect x="${cx + 4}" y="${y - 15}" width="22" height="13" rx="2" fill="${palette.cargo}" opacity="0.8"/>`;
    }
  }
  return out;
}

function tanker(x, y, palette) {
  return `<g>
    <ellipse cx="${x + 74}" cy="${y + 9}" rx="74" ry="12" fill="${palette.cargo}" opacity="0.85"/>
    <ellipse cx="${x + 74}" cy="${y + 6}" rx="74" ry="10" fill="#ffffff" opacity="0.22"/>
    <rect x="${x + 14}" y="${y - 6}" width="10" height="12" rx="2" fill="${palette.accent}"/>
    <rect x="${x + 60}" y="${y - 6}" width="10" height="12" rx="2" fill="${palette.accent}"/>
    <rect x="${x + 110}" y="${y - 6}" width="10" height="12" rx="2" fill="${palette.accent}"/>
  </g>`;
}

function ferry(x, y, palette) {
  return `<g>
    <rect x="${x + 8}" y="${y - 26}" width="96" height="26" rx="6" fill="#ffffff" opacity="0.9"/>
    <rect x="${x + 16}" y="${y - 22}" width="80" height="8" rx="3" fill="${palette.cargo}" opacity="0.7"/>
    <rect x="${x + 16}" y="${y - 10}" width="80" height="8" rx="3" fill="${palette.cargo}" opacity="0.45"/>
    <rect x="${x + 118}" y="${y - 34}" width="26" height="34" rx="5" fill="#ffffff" opacity="0.92"/>
    <rect x="${x + 124}" y="${y - 28}" width="14" height="10" rx="2" fill="${palette.hull}" opacity="0.6"/>
  </g>`;
}

function bulk(x, y, palette) {
  return `<g>
    <rect x="${x + 6}" y="${y - 16}" width="150" height="16" rx="8" fill="${palette.cargo}" opacity="0.85"/>
    <circle cx="${x + 40}" cy="${y - 22}" r="10" fill="${palette.accent}" opacity="0.8"/>
    <circle cx="${x + 84}" cy="${y - 24}" r="12" fill="${palette.cargo}" opacity="0.9"/>
    <circle cx="${x + 128}" cy="${y - 21}" r="9" fill="${palette.accent}" opacity="0.75"/>
  </g>`;
}

function buildSvg(level) {
  const p = PALETTES[level - 1];
  const kind = shipFor(level);
  const hullY = 214;
  const hullPath = `M96 ${hullY} L536 ${hullY} L506 276 Q300 296 126 276 Z`;

  let cargoLayer = '';
  if (kind === 0) cargoLayer = containers(150, hullY - 24, p, 4);
  else if (kind === 1) cargoLayer = containers(140, hullY - 24, p, 6);
  else if (kind === 2) cargoLayer = tanker(150, hullY - 22, p);
  else if (kind === 3) cargoLayer = ferry(150, hullY - 4, p);
  else cargoLayer = bulk(150, hullY - 12, p);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360" role="img" aria-label="Cargo ship illustration level ${level}">
  <defs>
    <linearGradient id="sky${level}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${p.sky[0]}"/>
      <stop offset="100%" stop-color="${p.sky[1]}"/>
    </linearGradient>
    <linearGradient id="sea${level}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1e7f56"/>
      <stop offset="100%" stop-color="#0a4a30"/>
    </linearGradient>
    <linearGradient id="hull${level}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${p.hull}"/>
      <stop offset="100%" stop-color="${p.deck}"/>
    </linearGradient>
  </defs>
  <rect width="640" height="360" fill="url(#sky${level})"/>
  <circle cx="520" cy="78" r="42" fill="${p.accent}" opacity="0.35"/>
  <circle cx="520" cy="78" r="26" fill="${p.accent}" opacity="0.55"/>
  <path d="M0 262 Q160 240 320 262 T640 262 L640 360 L0 360 Z" fill="url(#sea${level})"/>
  <path d="M0 288 Q120 272 240 288 T480 288 T720 288" stroke="#ffffff" stroke-opacity="0.25" stroke-width="3" fill="none"/>
  <path d="M0 322 Q140 306 280 322 T560 322 T840 322" stroke="#ffffff" stroke-opacity="0.16" stroke-width="3" fill="none"/>
  <g>
    <path d="${hullPath}" fill="url(#hull${level})"/>
    <path d="M96 ${hullY} L536 ${hullY} L532 ${hullY + 10} L100 ${hullY + 10} Z" fill="${p.accent}"/>
    <rect x="150" y="${hullY - 6}" width="300" height="6" rx="3" fill="#ffffff" opacity="0.18"/>
    ${cargoLayer}
    <rect x="440" y="${hullY - 74}" width="52" height="74" rx="6" fill="#ffffff"/>
    <rect x="450" y="${hullY - 64}" width="32" height="16" rx="3" fill="${p.hull}" opacity="0.55"/>
    <rect x="450" y="${hullY - 42}" width="32" height="16" rx="3" fill="${p.hull}" opacity="0.35"/>
    <rect x="452" y="${hullY - 92}" width="28" height="20" rx="4" fill="${p.deck}"/>
    <rect x="458" y="${hullY - 100}" width="16" height="10" rx="3" fill="${p.accent}"/>
    <path d="M474 ${hullY - 96} q18 -12 34 -6" stroke="#ffffff" stroke-opacity="0.55" stroke-width="5" fill="none" stroke-linecap="round"/>
    <circle cx="176" cy="${hullY + 4}" r="7" fill="${p.accent}"/>
    <circle cx="216" cy="${hullY + 4}" r="7" fill="${p.accent}"/>
    <circle cx="256" cy="${hullY + 4}" r="7" fill="${p.accent}"/>
  </g>
  <path d="M60 300 q40 -14 80 0" stroke="#ffffff" stroke-opacity="0.5" stroke-width="4" fill="none" stroke-linecap="round"/>
  <path d="M470 314 q46 -16 92 0" stroke="#ffffff" stroke-opacity="0.4" stroke-width="4" fill="none" stroke-linecap="round"/>
  <text x="32" y="44" font-family="Segoe UI, Arial, sans-serif" font-size="20" font-weight="700" fill="${p.deck}" opacity="0.75">SHIP TRANSFER</text>
  <text x="32" y="66" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="600" fill="${p.deck}" opacity="0.55">LEVEL ${level}</text>
</svg>
`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (let level = 1; level <= 13; level += 1) {
  fs.writeFileSync(path.join(OUT_DIR, `level-${level}.svg`), buildSvg(level), 'utf8');
}
console.log(`Generated 13 ship illustrations in ${path.relative(path.join(__dirname, '..'), OUT_DIR)}`);
