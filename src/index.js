/**
 * This module manages PostgreSQL connections in serverless applications.
 * This module wrap node-postgres package, more detail regarding it can be found here:
 * https://github.com/brianc/node-postgres
 * @author Matteo Gioioso <matteo@hirvitek.com>
 * @version 1.1.0
 * @license MIT
 */

const { Client } = require("pg");

function ServerlessClient(config) {
  this._config = config;

  // If this parameters is set to true it will query to get the maxConnections values,
  // to maximize performance you should set the maxConnections yourself.
  // Is suggested to manually set the maxConnections and keep this setting to false.
  this._automaticMaxConnections = config.automaticMaxConnections
  // Cache expiration for getting the max connections value in milliseconds
  this._maxConnsFreqMs = config.maxConnsFreqMs || 60000;
  this._maxConnections = config.maxConnections || 100;
  this._maxConnectionsCache = {
    total: this._maxConnections,
    updated: Date.now()
  }

  // Activate debugging logger
  this._debug = config.debug

  // The bigger, the more idle connections will be possibly dropped
  this._maxIdleConnections = config.maxIdleConnections || 10;

  // The percentage of total connections to use when connecting to your Postgres server.
  // A value of 0.75 would use 75% of your total available connections.
  // Past this threshold the connection killer will kick in.
  this._connUtilization = config.connUtilization || 0.8

  this._backoff = {
    capMs: config.capMs,
    baseMs: config.baseMs,
    delayMs: config.retryDelayMs || 1000,
    maxRetries: config.maxRetries || 3,
    retries: 0,
  }
}

ServerlessClient.prototype.constructor = ServerlessClient;
ServerlessClient.prototype._sleep = delay =>
  new Promise(resolve => {
    setTimeout(() => {
      resolve();
    }, delay);
  });

ServerlessClient.prototype._setMaxConnections = async () => {
  // If cache is expired
  if (Date.now() - this._maxConnectionsCache.updated > this._maxConnsFreqMs) {
    const results = await this._client.query(
      `SHOW max_connections`
    )

    this._logger("Getting max connections from database...")

    this._maxConnectionsCache = {
      total: results.rows[0],
      updated: Date.now()
    }
  }

  this._maxConnections = this._maxConnectionsCache.total
}

ServerlessClient.prototype._getIdleProcessesListOrderByDate = async function() {
  const result =  await this._client.query(
    `SELECT pid,backend_start,state 
        FROM pg_stat_activity 
        WHERE datname=$1 AND state='idle' 
        ORDER BY backend_start 
        DESC LIMIT $2;`,
    [this._config.database, this._maxIdleConnections]
  );

  return result.rows
};

ServerlessClient.prototype._getProcessesCount = async function() {
  const result = await this._client.query(
    "SELECT COUNT(pid) FROM pg_stat_activity WHERE datname=$1 AND state='idle';",
    [this._config.database]
  );

  return result.rows[0].count;
};

ServerlessClient.prototype._killProcesses = async function(processesList) {
  const pids = processesList.map(proc => proc.pid);
  const query = `
    SELECT pg_terminate_backend(pid) 
    FROM pg_stat_activity 
    WHERE pid = ANY ($1) 
      AND datname = $2 AND state='idle';`
  const values = [pids, this._config.database]

  return this._client.query(query, values)
};

ServerlessClient.prototype._decorrelatedJitter = function(delay= 0){
  const cap = Number.isInteger(this._backoff.capMs) ? this._backoff.capMs : 100 // default to 100 ms
  const base = Number.isInteger(this._backoff.baseMs) ? this._backoff.baseMs : 2 // default to 2 ms
  const randRange = (min,max) => Math.floor(Math.random() * (max - min + 1)) + min
  return Math.min(cap, randRange(base, delay * 3))
}

ServerlessClient.prototype.clean = async function() {
  const processCount = await this._getProcessesCount();
  this._logger("Current process count: ", processCount)

  if (processCount > this._maxConnections * this._connUtilization) {
    const processesList = await this._getIdleProcessesListOrderByDate();
    await this._killProcesses(processesList);
    this._logger("Killed processes: ", processesList.length)
  }
};

ServerlessClient.prototype.sconnect = async function() {
  try {
    await this._init()
    await this._client.connect();
  } catch (e) {
    if (e.message === "sorry, too many clients already") {
      // Client in node-pg is usable only one time, once it errors we cannot re-connect again,
      // therefore we need to throw the instance and recreate a new one
      await this._init()
      const backoff = async delay => {
        if (this._backoff.retries < this._backoff.maxRetries) {
          this._logger(this._backoff.maxRetries, " trying to reconnect... ")
          const totalDelay = this._decorrelatedJitter(delay)
          this._logger("total delay: ", totalDelay)
          await this._sleep(totalDelay);
          this._backoff.retries++;
          await this.sconnect();
          this._logger("Re-connection successful after ", this._backoff.retries)
        }
      };

      this._logger("Current delay: ", this._backoff.delayMs)
      await backoff(this._backoff.delayMs);
    } else {
      throw e;
    }
  }
};

ServerlessClient.prototype._init = async function(){
  this._client = new Client(this._config)

  if (this._automaticMaxConnections){
    await this._setMaxConnections()
  }

  this._logger("Max connections: ", this._maxConnections)

  // pg throws an error if we terminate the connection, therefore we need to swallow these errors
  // and throw the rest
  this._client.on("error", err => {
    if (
      err.message === "terminating connection due to administrator command" ||
      err.message === "Connection terminated unexpectedly"
    ) {
      // Swallow the error
    } else if (err.message === "sorry, too many clients already") {
      throw err;
    } else {
      throw err;
    }
  });
}

// TODO add validation for the client config
ServerlessClient.prototype._validateConfig = function(){

}

ServerlessClient.prototype._logger = function(...args) {
  if (this._debug){
    console.log('\x1b[36m%s\x1b[0m', 'serverless-pg | ', ...args)
  }
}

ServerlessClient.prototype.query = async function(...args){
  return this._client.query(...args)
}

ServerlessClient.prototype.end = async function(){
  return this._client.end()
}

ServerlessClient.prototype.on = function(...args){
  return this._client.on(...args)
}

module.exports = { ServerlessClient };
