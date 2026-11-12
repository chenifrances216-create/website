'use strict';

const { createApp } = require('./src/app');

const port = Number(process.env.PORT || 3000);
const app = createApp();

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Ship Transfer imeanza kwenye bandari ${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
