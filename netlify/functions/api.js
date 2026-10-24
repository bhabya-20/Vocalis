const serverless = require('serverless-http');
const { app, initializeDatabase } = require('../../server');

const expressHandler = serverless(app);
let databaseReady;

exports.handler = async (event, context) => {
  databaseReady ||= initializeDatabase();
  await databaseReady;
  return expressHandler(event, context);
};
