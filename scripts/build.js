'use strict';

/**
 * Ukaguzi wa muundo wa mradi kabla ya kupeleka mtandaoni.
 * Haukundi kitu; huhakikisha faili zote muhimu zipo na moduli zinasomeka.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const required = [
  'package.json',
  'server.js',
  'src/app.js',
  'src/domain.js',
  'src/auth.js',
  'src/db.js',
  'src/constants.js',
  'public/index.html',
  'public/styles.css',
  'public/app.js',
];

const missing = required.filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error(`Faili hazipo: ${missing.join(', ')}`);
  process.exit(1);
}

const { createApp } = require(path.join(root, 'src/app.js'));
const app = createApp();
if (typeof app.listen !== 'function') {
  console.error('createApp() haikurejesha seva ya Express');
  process.exit(1);
}

const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
if (!html.includes('app.js') || !html.includes('styles.css')) {
  console.error('index.html haijaunganisha styles.css/app.js');
  process.exit(1);
}

console.log(`Muundo wa Ship Transfer uko sawa (${required.length} faili muhimu).`);
