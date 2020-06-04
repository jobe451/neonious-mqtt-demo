'use strict';

const mqtt = require('mqtt-connection');
const state2string = require('./common').state2string;
const convertTopic2id = require('./common').convertTopic2id;
const convertID2topic = require('./common').convertID2topic;
const messageboxRegex = new RegExp('\\.messagebox$');

// todo delete from persistentSessions the sessions and messages after some time

function MQTTServer(adapter, states) {
    if (!(this instanceof MQTTServer)) {
        return new MQTTServer(adapter, states);
    }

    let net;
    let http;
    let ws;
    let wsStream;
    let server = null;
    let serverWs = null;
    let serverForWs = null;
    const clients = {};
    const topic2id = {};
    const id2topic = {};
    let messageId = 1;
    let persistentSessions = {};
    let resending = false;
    let resendTimer = null;


    this.onMessage = (topic, message) => { 
        console.log(topic, message, "message");
    };



    function checkPattern(patterns, id) {
        for (const pattern in patterns) {
            if (patterns.hasOwnProperty(pattern) && patterns[pattern].regex.test(id)) {
                return patterns[pattern];
            }
        }

        return null;
    }


    function pattern2RegEx(pattern) {
        pattern = convertTopic2id(pattern, true, adapter.config.prefix, adapter.namespace);
        pattern = pattern.replace(/#/g, '*');
        pattern = pattern.replace(/\$/g, '\\$');
        pattern = pattern.replace(/\^/g, '\\^');

        if (pattern !== '*') {
            if (pattern[0] === '*' && pattern[pattern.length - 1] !== '*') pattern += '$';
            if (pattern[0] !== '*' && pattern[pattern.length - 1] === '*') pattern = '^' + pattern;
            if (pattern[0] === '+') pattern = '^[^.]*' + pattern.substring(1);
            if (pattern[pattern.length - 1] === '+') pattern = pattern.substring(0, pattern.length - 1) + '[^.]*$';
        }
        pattern = pattern.replace(/\./g, '\\.');
        pattern = pattern.replace(/\*/g, '.*');
        pattern = pattern.replace(/\+/g, '[^.]*');
        return pattern;
    }

    function receivedTopic(packet, client, cb) {
        let isAck = true;
        let topic = packet.topic;
        let message = packet.payload;
        const qos = packet.qos;
        const retain = packet.retain;
        const now = Date.now();
        let id;

        if (adapter.config.extraSet) {
            if (packet.topic.match(/\/set$/)) {
                isAck = false;
                packet.topic = packet.topic.substring(0, packet.topic.length - 4);
                topic = packet.topic;
            }
        }

        if (topic2id[topic]) {
            id = topic2id[topic].id || convertTopic2id(topic, false, adapter.config.prefix, adapter.namespace);
        } else {
            id = convertTopic2id(topic, false, adapter.config.prefix, adapter.namespace);
        }

        if (!id) {
            if (cb) {
                cb();
                cb = null;
            }
            return;
        }

        //console.log('Type: ' + typeof message);
        let type = typeof message;

        if (type !== 'string' && type !== 'number' && type !== 'boolean') {
            message = message ? message.toString('utf8') : 'null';
            type = 'string';
        }

        // try to convert 101,124,444,... To utf8 string
        if (type === 'string' && message.match(/^(\d)+,\s?(\d)+,\s?(\d)+/)) {
            //console.log('Try to convert ' + message);

            const parts = message.split(',');
            try {
                let str = '';
                for (let p = 0; p < parts.length; p++) {
                    str += String.fromCharCode(parseInt(parts[p].trim(), 10));
                }
                message = str;
            } catch (e) {
                // cannot convert and ignore it
            }
            //console.log('Converted ' + message);
        }

        // If state is unknown => create mqtt.X.topic
        if (type === 'string') {
            // Try to convert value
            let _val = message.replace(',', '.').replace(/^\+/, '');

            // +23.560 => 23.56, -23.000 => -23
            if (_val.indexOf('.') !== -1) {
                let i = _val.length - 1;
                while (_val[i] === '0' || _val[i] === '.') {
                    i--;
                    if (_val[i + 1] === '.') break;
                }
                if (_val[i + 1] === '0' || _val[i + 1] === '.') {
                    _val = _val.substring(0, i + 1);
                }
            }
            const f = parseFloat(_val);

            if (f.toString() === _val) message = f;
            if (message === 'true') message = true;
            if (message === 'false') message = false;
        }

        if (type === 'string' && message[0] === '{') {
            try {
                const _message = JSON.parse(message);
                // Fast solution
                if (_message.val !== undefined) {
                    message = _message;
                    // Really right, but slow
                    //var valid = true;
                    //for (var attr in _message) {
                    //    if (!_message.hasOwnProperty(attr)) continue;
                    //    if (attr !== 'val' && attr !== 'ack' && attr !== 'ts' && attr !== 'q' &&
                    //        attr !== 'lc' && attr !== 'comm' && attr !== 'lc') {
                    //        valid = false;
                    //        break;
                    //    }
                    //}
                    //if (valid) message = _message;
                }
            } catch (e) { }
        }

    }

    function clientClose(client, reason) {
        if (!client) return;

        if (persistentSessions[client.id]) {
            persistentSessions[client.id].connected = false;
        }

        if (client._sendOnStart) {
            clearTimeout(client._sendOnStart);
            client._sendOnStart = null;
        }
        if (client._resendonStart) {
            clearTimeout(client._resendonStart);
            client._resendonStart = null;
        }

        try {
            if (clients[client.id] && (client.__secret === clients[client.id].__secret)) {
                console.log(`Client [${client.id}] connection closed: ${reason}`);
                delete clients[client.id];
                if (client._will) {
                    receivedTopic(client._will, client, () => client.destroy());
                } else {
                    client.destroy();
                }
            } else {
                client.destroy();
            }
        } catch (e) {
            console.log(`Client [${client.id}] Cannot close client: ${e}`);
        }
    }

    function startServer(config, socket, server, port, bind, ssl, ws) {
        socket.on('connection', stream => {
            let client;
            if (ws) {
                client = mqtt(wsStream(stream));
            } else {
                client = mqtt(stream);
            }

            // Store unique connection identifier
            client.__secret = Date.now() + '_' + Math.round(Math.random() * 10000);

            client.on('connect', options => {
                // set client id
                client.id = options.clientId;
                if (adapter.config.forceCleanSession === 'clean') {
                    client.cleanSession = true;
                } else if (adapter.config.forceCleanSession === 'keep') {
                    client.cleanSession = false;
                } else {
                    client.cleanSession = options.cleanSession === undefined ? options.cleanSession : options.clean;
                }

                client._keepalive = options.keepalive;

                // get possible old client
                const oldClient = clients[client.id];

                if (config.user) {
                    if (config.user !== options.username ||
                        config.pass !== (options.password || '').toString()) {
                        console.log(`Client [${client.id}]  has invalid password(${options.password}) or username(${options.username})`);
                        client.connack({ returnCode: 4 });
                        if (oldClient) {
                            // delete existing client
                            delete clients[client.id];
                            oldClient.destroy();
                        }
                        client.destroy();
                        return;
                    }
                }

                if (oldClient) {
                    console.log(`Client [${client.id}] reconnected. Old secret ${clients[client.id].__secret}. New secret ${client.__secret}`);
                    // need to destroy the old client

                    if (client.__secret !== clients[client.id].__secret) {
                        // it is another socket!!

                        // It was following situation:
                        // - old connection was active
                        // - new connection is on the same TCP
                        // Just forget him
                        // oldClient.destroy();
                    }
                } else {
                    console.log(`Client [${client.id}] connected with secret ${client.__secret}`);
                }

                let sessionPresent = false;

                if (!client.cleanSession && adapter.config.storeClientsTime !== 0) {
                    if (persistentSessions[client.id]) {
                        sessionPresent = true;
                        persistentSessions[client.id].lastSeen = Date.now();
                    } else {
                        persistentSessions[client.id] = {
                            _subsID: {},
                            _subs: {},
                            messages: [],
                            lastSeen: Date.now()
                        };
                    }
                    client._messages = persistentSessions[client.id].messages || [];
                    persistentSessions[client.id].connected = true;
                } else if (client.cleanSession && persistentSessions[client.id]) {
                    delete persistentSessions[client.id];
                }
                client._messages = client._messages || [];

                client.connack({ returnCode: 0, sessionPresent });
                clients[client.id] = client;

                if (options.will) { //  the client's will message options. object that supports the following properties:
                    // topic:   the will topic. string
                    // payload: the will payload. string
                    // qos:     will qos level. number
                    // retain:  will retain flag. boolean
                    client._will = JSON.parse(JSON.stringify(options.will));
                    let id;
                    if (topic2id[client._will.topic]) {
                        id = topic2id[client._will.topic].id || convertTopic2id(client._will.topic, false, config.prefix, adapter.namespace);
                    } else {
                        id = convertTopic2id(client._will.topic, false, config.prefix, adapter.namespace);
                    }

                    //something went wrong while JSON.parse, so payload of last will not handeled correct as buffer
                    client._will.payload = options.will.payload;
                    console.log(`Client [${client.id}] with last will ${JSON.stringify(client._will)}`);
                }

                // Send all subscribed variables to client
                if (config.publishAllOnStart) {
                    // Give to client 2 seconds to send subscribe
                    client._sendOnStart = setTimeout(() => {
                        client._sendOnStart = null;
                        const list = [];
                        // If client still connected
                        for (const id in states) {
                            if (states.hasOwnProperty(id)) {
                                list.push(id);
                            }
                        }
                        sendStates2Client(client, list);
                    }, adapter.config.sendOnStartInterval);
                }

                if (persistentSessions[client.id]) {
                    client._subsID = persistentSessions[client.id]._subsID;
                    client._subs = persistentSessions[client.id]._subs;
                    if (persistentSessions[client.id].messages.length) {
                        // give to the client a little bit time
                        client._resendonStart = setTimeout(clientId => {
                            client._resendonStart = null;
                            resendMessages2Client(client, persistentSessions[clientId].messages);
                        }, 100, client.id);
                    }
                }

                //set timeout for stream to 1,5 times keepalive [MQTT-3.1.2-24].
                if (client._keepalive !== 0) {
                    const streamtimeout_sec = 1.5 * client._keepalive;
                    stream.setTimeout(streamtimeout_sec * 1000);

                    console.log(`Client [${client.id}] with keepalive ${client._keepalive} set timeout to ${streamtimeout_sec} seconds`);
                }
            });

            client.on('publish', packet => {
                if (clients[client.id] && client.__secret !== clients[client.id].__secret) {
                    return console.log(`Old client ${client.id} with secret ${client.__secret} sends publish. Ignore! Actual secret is ${clients[client.id].__secret}`);
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                if (packet.qos === 1) {
                    // send PUBACK to client
                    client.puback({
                        messageId: packet.messageId
                    });
                } else if (packet.qos === 2) {
                    const pack = client._messages && client._messages.find(e => e.messageId === packet.messageId);
                    if (pack) {
                        // duplicate message => ignore
                        console.log(`Client [${client.id}] Ignored duplicate message with ID: ${packet.messageId}`);
                        return;
                    } else {
                        packet.ts = Date.now();
                        packet.cmd = 'pubrel';
                        packet.count = 0;
                        client._messages = client._messages || [];
                        client._messages.push(packet);

                        client.pubrec({
                            messageId: packet.messageId
                        });
                        return;
                    }
                }

                receivedTopic(packet, client);
            });

            // response for QoS2
            client.on('pubrec', packet => {
                if (clients[client.id] && client.__secret !== clients[client.id].__secret) {
                    return console.log(`Old client ${client.id} with secret ${client.__secret} sends pubrec. Ignore! Actual secret is ${clients[client.id].__secret}`);
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                // remove this message from queue
                const frame = client._messages && client._messages.find(e => e.messageId === packet.messageId);
                if (frame) {
                    client.pubrel({
                        messageId: packet.messageId
                    });
                } else {
                    console.log(`Client [${client.id}] Received pubrec on ${client.id} for unknown messageId ${packet.messageId}`);
                }
            });

            // response for QoS2
            client.on('pubcomp', packet => {
                if (clients[client.id] && client.__secret !== clients[client.id].__secret) {
                    return console.log(`Old client ${client.id} with secret ${client.__secret} sends pubcomp. Ignore! Actual secret is ${clients[client.id].__secret}`);
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                let pos = null;
                // remove this message from queue
                client._messages && client._messages.forEach((e, i) => {
                    if (e.messageId === packet.messageId) {
                        pos = i;
                        return false;
                    }
                });
                if (pos !== null) {
                    client._messages.splice(pos, 1);
                } else {
                    console.log(`Client [${client.id}] Received pubcomp for unknown message ID: ${packet.messageId}`);
                }
            });

            // response for QoS2
            client.on('pubrel', packet => {
                if (clients[client.id] && client.__secret !== clients[client.id].__secret) {
                    return console.log(`Old client ${client.id} with secret ${client.__secret} sends pubrel. Ignore! Actual secret is ${clients[client.id].__secret}`);
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                // remove this message from queue
                const frame = client._messages && client._messages.find(e => e.messageId === packet.messageId);
                if (frame) {
                    client.pubcomp({
                        messageId: packet.messageId
                    });
                    receivedTopic(frame, client);
                } else {
                    console.log(`Client [${client.id}] Received pubrel on ${client.id} for unknown messageId ${packet.messageId}`);
                }
            });

            // response for QoS1
            client.on('puback', packet => {
                if (clients[client.id] && client.__secret !== clients[client.id].__secret) {
                    return console.log(`Old client ${client.id} with secret ${client.__secret} sends puback. Ignore! Actual secret is ${clients[client.id].__secret}`);
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                // remove this message from queue
                let pos = null;
                // remove this message from queue
                client._messages && client._messages.forEach((e, i) => {
                    if (e.messageId === packet.messageId) {
                        pos = i;
                        return false;
                    }
                });
                if (pos !== null) {
                    console.log(`Client [${client.id}] Received puback for ${client.id} message ID: ${packet.messageId}`);
                    client._messages.splice(pos, 1);
                } else {
                    console.log(`Client [${client.id}] Received puback for unknown message ID: ${packet.messageId}`);
                }
            });

            client.on('subscribe', packet => {
                if (clients[client.id] && client.__secret !== clients[client.id].__secret) {
                    return console.log(`Old client ${client.id} with secret ${client.__secret} sends subscribe. Ignore! Actual secret is ${clients[client.id].__secret}`);
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                const granted = [];
                client._subsID = client._subsID || {};
                client._subs = client._subs || {};

                for (let i = 0; i < packet.subscriptions.length; i++) {
                    granted.push(packet.subscriptions[i].qos);

                    const topic = packet.subscriptions[i].topic;
                    let id;

                    if (topic2id[topic]) {
                        id = topic2id[topic].id || convertTopic2id(topic, false, config.prefix, adapter.namespace);
                    } else {
                        id = convertTopic2id(topic, false, config.prefix, adapter.namespace);
                    }

                    if (!id) {
                        console.log(`Client [${client.id}] Invalid topic: ${topic}`);
                        continue;
                    }

                    // if pattern without wildcards
                    if (id.indexOf('*') === -1 && id.indexOf('#') === -1 && id.indexOf('+') === -1) {
                        // If state is unknown => create mqtt.X.topic
                        if (topic2id[topic]) {
                            client._subsID[topic2id[topic].id] = { id: topic2id[topic].id, qos: packet.subscriptions[i].qos };
                            console.log(`Client [${client.id}] subscribes on "${topic2id[topic].id}"`);
                            if (adapter.config.publishOnSubscribe) {
                                console.log(`Client [${client.id}] publishOnSubscribe`);
                                sendState2Client(client, topic2id[topic].id, states[topic2id[topic].id]);
                            }
                        }
                    } else {
                        let pattern = topic;
                        // remove prefix
                        if (pattern.startsWith(adapter.config.prefix)) {
                            pattern = pattern.substring(adapter.config.prefix.length);
                        }
                        pattern = pattern.replace(/\//g, '.');
                        if (pattern[0] === '.') pattern = pattern.substring(1);

                        // add simple pattern
                        let regText = pattern2RegEx(pattern);
                        client._subs[topic] = {
                            regex: new RegExp(regText),
                            qos: packet.subscriptions[i].qos,
                            pattern: pattern
                        };
                        console.log(`Client [${client.id}] subscribes on "${topic}" with regex /${regText}/`);

                        // add simple mqtt.0.pattern
                        pattern = adapter.namespace + '/' + pattern;
                        regText = pattern2RegEx(pattern);
                        client._subs[adapter.namespace + '/' + topic] = {
                            regex: new RegExp(regText),
                            qos: packet.subscriptions[i].qos,
                            pattern: pattern
                        };
                        console.log(`Client [${client.id}] subscribes on "${topic}"  with regex /${regText}/`);

                        if (adapter.config.publishOnSubscribe) {
                            console.log(`Client [${client.id}] publishOnSubscribe send all known states`);
                            for (const savedId in states) {
                                if (states.hasOwnProperty(savedId) && checkPattern(client._subs, savedId)) {
                                    sendState2Client(client, savedId, states[savedId]);
                                }
                            }
                        }
                    }
                }

                client.suback({ granted: granted, messageId: packet.messageId });
            });

            client.on('unsubscribe', packet => {
                if (clients[client.id] && client.__secret !== clients[client.id].__secret) {
                    return console.log(`Old client ${client.id} with secret ${client.__secret} sends unsubscribe. Ignore! Actual secret is ${clients[client.id].__secret}`);
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                for (let i = 0; i < packet.unsubscriptions.length; i++) {
                    const topic = packet.unsubscriptions[i];
                    let id;

                    if (topic2id[topic]) {
                        id = topic2id[topic].id || convertTopic2id(topic, false, config.prefix, adapter.namespace);
                    } else {
                        id = convertTopic2id(topic, false, config.prefix, adapter.namespace);
                    }

                    if (!id) {
                        console.log(`Client [${client.id}] unsubscribes from invalid topic: ${topic}`);
                        continue;
                    }

                    // if pattern without wildcards
                    if (id.indexOf('*') === -1 && id.indexOf('#') === -1 && id.indexOf('+') === -1) {
                        // If state is known
                        if (topic2id[topic]) {
                            const _id = topic2id[topic].id;
                            if (client._subsID[_id]) {
                                delete client._subsID[_id];
                                console.log(`Client [${client.id}] unsubscribes on "${_id}"`);
                            } else {
                                console.log(`Client [${client.id}] unsubscribes on unknown "${_id}"`);
                            }
                        } else {
                            console.log(`Client [${client.id}] unsubscribes on unknown topic "${topic}"`);
                        }
                    } else {
                        let pattern = topic.replace(/\//g, '.');
                        if (pattern[0] === '.') pattern = pattern.substring(1);

                        // add simple pattern
                        if (client._subs[topic]) {
                            console.log(`Client [${client.id}] unsubscribes on "${topic}"`);
                            delete client._subs[topic];
                            if (client._subs[adapter.namespace + '/' + topic]) { // add simple mqtt.0.pattern
                                delete client._subs[adapter.namespace + '/' + topic];
                                console.log(`Client [${client.id}] unsubscribes on "${adapter.namespace}/${topic}"`);
                            }
                        } else {
                            console.log(`Client [${client.id}] unsubscribes on unknwon "${topic}"`);
                        }
                    }
                }
                client.unsuback({ messageId: packet.messageId });
            });

            client.on('pingreq', ( /*packet*/) => {
                if (clients[client.id] && client.__secret !== clients[client.id].__secret) {
                    return console.log(`Old client ${client.id} with secret ${client.__secret} sends pingreq. Ignore! Actual secret is ${clients[client.id].__secret}`);
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                console.log(`Client [${client.id}]  pingreq`);
                client.pingresp();
            });

            // connection error handling
            client.on('close', had_error => clientClose(client, had_error ? 'closed because of error' : 'closed'));
            client.on('error', e => clientClose(client, e));
            client.on('disconnect', () => clientClose(client, 'disconnected'));

            // client lost without close
            stream.on('timeout', () => clientClose(client, 'timeout'));

        });
        (server || socket).listen(port, bind, () =>
            console.log(`Starting MQTT${ws ? '-WebSocket' : ''}${ssl ? ' (Secure)' : ''}${config.user ? ' authenticated' : ''} server on ${bind || '0.0.0.0'}:${port}`));
    }

    function checkResends() {
        const now = Date.now();
        resending = true;
        for (const clientId in clients) {
            if (clients.hasOwnProperty(clientId) && clients[clientId] && clients[clientId]._messages) {
                for (let m = clients[clientId]._messages.length - 1; m >= 0; m--) {
                    const message = clients[clientId]._messages[m];
                    if (now - message.ts >= adapter.config.retransmitInterval) {
                        if (message.count > adapter.config.retransmitCount) {
                            console.log(`Client [${clientId}] Message ${message.messageId} deleted after ${message.count} retries`);
                            clients[clientId]._messages.splice(m, 1);
                            continue;
                        }

                        // resend this message
                        message.count++;
                        message.ts = now;
                        try {
                            console.log(`Client [${clientId}] Resend message topic: ${message.topic}, payload: ${message.payload}`);
                            if (message.cmd === 'publish') {
                                clients[clientId].publish(message);
                            }
                        } catch (e) {
                            console.log(`Client [${clientId}] Cannot publish message: ${e}`);
                        }

                        if (adapter.config.sendInterval) {
                            setTimeout(checkResends, adapter.config.sendInterval);
                        } else {
                            setImmediate(checkResends);
                        }
                        return;
                    }
                }
            }
        }

        // delete old sessions
        if (adapter.config.storeClientsTime !== -1) {
            Object.keys(persistentSessions).forEach(id => {
                if (now - persistentSessions[id].lastSeen > adapter.config.storeClientsTime * 60000) {
                    delete persistentSessions[id];
                }
            });
        }

        resending = false;
    }

    (function _constructor(config) {
        // create connected object and state

        config.port = parseInt(config.port, 10) || 1883;
        config.retransmitInterval = config.retransmitInterval || 2000;
        config.retransmitCount = config.retransmitCount || 10;
        if (config.storeClientsTime === undefined) {
            config.storeClientsTime = 1440;
        } else {
            config.storeClientsTime = parseInt(config.storeClientsTime, 10) || 0;
        }

        config.defaultQoS = parseInt(config.defaultQoS, 10) || 0;

        if (config.ssl) {
            net = net || require('tls');
            if (config.webSocket) {
                http = http || require('https');
            }
        } else {
            net = net || require('net');
            if (config.webSocket) {
                http = http || require('http');
            }
        }

        server = new net.Server(config.certificates);

        startServer(config, server, null, config.port, config.bind, config.ssl, false);

        if (config.webSocket) {
            http = http || require('https');
            ws = ws || require('ws');
            wsStream = wsStream || require('websocket-stream');
            serverForWs = http.createServer(config.certificates);
            serverWs = new ws.Server({ server: serverForWs });

            startServer(config, serverWs, serverForWs, config.port + 1, config.bind, config.ssl, true);
        }

        resendTimer = setInterval(() =>
            !resending && checkResends(), adapter.config.retransmitInterval || 2000);

    })(adapter.config);

    return this;
}

module.exports = MQTTServer;