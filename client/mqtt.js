require('mqtt-packet').writeToStream.cacheNumbers = false;
const MQTT = require("mqtt");

console.log("START");
let client = MQTT.connect("mqtt://localhost");

console.log("client instance created");
client.on("connect", () => {
    console.log("connected")

    client.subscribe("presence", () => {console.log("subscribed")});

    client.on('message', (topic, message) => {
        console.log(topic, message.toString())
    })
});