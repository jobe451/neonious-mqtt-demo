const MQTTserver = require('./ioBroker-mqtt/server')

const adapter = {
    config: {
        defaultQoS: 0,
        retain: true,
        persistent: true,
        retransmitInterval: 2000,
        retransmitCount: 10,
        sendInterval: 400,
        forceCleanSession: 'no'
    },
    namespace: "foobar",
}


const states = {};

new MQTTserver(adapter, states);