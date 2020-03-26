'use strict';
const fs = require('fs');
const config = require('config');
const uuid = require('uuid');
const os = require('os');
const child_process = require('child_process');
const http = require('http');
const https = require('https');

const WebSocketServer = require('ws').Server;

const maxmind = require('maxmind');
const cityLookup = maxmind.open('./GeoLite2-City.mmdb');

const obfuscate = require('./obfuscator');
const Database = require('./database')({
    firehose: config.get('firehose'),
});
const Store = require('./store')({
  s3: config.get('s3'),
});

let server;
const tempPath = 'temp';

const prom = require('prom-client');
const connected = new prom.Gauge({
  name: 'rtcstats_websocket_connections',
  help: 'number of open websocket connections',
});
const processed = new prom.Counter({
  name: 'rtcstats_files_processed',
  help: 'number of files processed',
});
const errored = new prom.Counter({
  name: 'rtcstats_files_errored',
  help: 'number of files with errors during processing',
});

class ProcessQueue {
    constructor() {
        this.maxProc = os.cpus().length;
        this.q = [];
        this.numProc = 0;
    }
    enqueue(clientid) {
        this.q.push(clientid);
        if (this.numProc < this.maxProc) {
            process.nextTick(this.process.bind(this));
        } else {
            console.log('process Q too long:', this.numProc);
        }
    }
    process() {
        const clientid = this.q.shift();
        if (!clientid) return;
        const p = child_process.fork('extract.js', [clientid]);
        p.on('exit', (code) => {
            this.numProc--;
            console.log('done', clientid, this.numProc, 'code=' + code);
            if (code === 0) {
                processed.inc();
            } else {
                errored.inc();
            }
            if (this.numProc < 0) this.numProc = 0;
            if (this.numProc < this.maxProc) process.nextTick(this.process.bind(this));
            fs.readFile(tempPath + '/' + clientid, {encoding: 'utf-8'}, (err, data) => {
                if (err) {
                    console.error('Could not open file for store upload', err);
                    return;
                }
                // remove the file
                fs.unlink(tempPath + '/' + clientid, () => {
                    // we're good...
                });
                Store.put(clientid, data);
            });
        });
        p.on('message', (msg) => {
            const {url, clientid, connid, clientFeatures, connectionFeatures, streamFeatures} = msg;
            Database.put(url, clientid, connid, clientFeatures, connectionFeatures, streamFeatures);
        });
        p.on('error', () => {
            this.numProc--;
            console.log('failed to spawn, rescheduling', clientid, this.numProc);
            this.q.push(clientid); // do not immediately retry
        });
        this.numProc++;
        if (this.numProc > 10) {
            console.log('process Q:', this.numProc);
        }
    }
}
const q = new ProcessQueue();

function setupWorkDirectory() {
    try {
        fs.readdirSync(tempPath).forEach(fname => {
            fs.unlinkSync(tempPath + '/' + fname);
        });
        fs.rmdirSync(tempPath);
    } catch(e) {
        console.error('work dir does not exist');
    }
    fs.mkdirSync(tempPath);
}

function getRequestAddress(request) {
    const forwardedFor = request.headers['x-forwarded-for'];
    if (forwardedFor) {
        const tokens = forwardedFor.split(",");
        return tokens[tokens.length - 1].trim();
    } else {
        const {remoteAddress} = request.connection;
        return remoteAddress;
    }
}

function run(keys) {
    setupWorkDirectory();

    if (keys === undefined) {
      server = http.Server(() => { });
    } else {
      server = https.Server({
          key: keys.serviceKey,
          cert: keys.certificate,
      }, () => { });
    }

    server.listen(config.get('server').port);
    server.on('request', (request, response) => {
        // look at request.url
        switch (request.url) {
        case '/healthcheck':
            response.writeHead(200);
            response.end();
            break;
        default:
            response.writeHead(404);
            response.end();
        }
    });

    const metricsPort = config.get('server').metrics;
    if (metricsPort) {
        const metricsServer = http.Server();
        metricsServer.listen(config.get('server').metrics);
        metricsServer.on('request', (request, response) => {
            switch (request.url) {
            case '/metrics':
                response.writeHead(200, {'Content-Type': prom.contentType});
                response.end(prom.register.metrics());
                break;
            default:
                response.writeHead(404);
                response.end();
            }
        });
    }

    const wss = new WebSocketServer({ server: server });
    wss.on('connection', (client, upgradeReq) => {
        connected.inc();
        let numberOfEvents = 0;
        // the url the client is coming from
        const referer = upgradeReq.headers['origin'] + upgradeReq.url;
        // TODO: check against known/valid urls

        const ua = upgradeReq.headers['user-agent'];
        const clientid = uuid.v4();
        let tempStream = fs.createWriteStream(tempPath + '/' + clientid);
        tempStream.on('finish', () => {
            if (numberOfEvents > 0) {
                q.enqueue(clientid);
            } else {
                fs.unlink(tempPath + '/' + clientid, () => {
                    // we're good...
                });
            }
        });

        const meta = {
            path: upgradeReq.url,
            origin: upgradeReq.headers['origin'],
            url: referer,
            userAgent: ua,
            time: Date.now(),
            fileFormat: 2,
        };
        tempStream.write(JSON.stringify(meta) + '\n');

        const address = getRequestAddress(upgradeReq);
        if (address) {
            process.nextTick(() => {
                const city = cityLookup.get(address);
                if (tempStream) {
                    tempStream.write(JSON.stringify(['location', null, city, Date.now()]) + '\n');
                }
            });
        }

        console.log('connected', ua, referer, clientid);

        client.on('message', msg => {
            try {
                const data = JSON.parse(msg);

                numberOfEvents++;
                switch(data[0]) {
                case 'getUserMedia':
                case 'getUserMediaOnSuccess':
                case 'getUserMediaOnFailure':
                case 'navigator.mediaDevices.getUserMedia':
                case 'navigator.mediaDevices.getUserMediaOnSuccess':
                case 'navigator.mediaDevices.getUserMediaOnFailure':
                    tempStream.write(JSON.stringify(data) + '\n');
                    break;
                default:
                    obfuscate(data);
                    tempStream.write(JSON.stringify(data) + '\n');
                    break;
                }
            } catch(e) {
                console.error('error while processing', e, msg);
            }
        });

        client.on('close', () => {
            connected.dec();
            tempStream.write(JSON.stringify(['close', null, null, Date.now()]));
            tempStream.end();
            tempStream = null;
        });
    });
}

function stop() {
    if (server) {
        server.close();
    }
}

run();

module.exports = {
    stop: stop
};
