const fs = require('fs');
const path = require('path');

module.exports = function(RED) {
    function WhatsappIn(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var whatsappLinkNode = RED.nodes.getNode(config.whatsappLink);
        node.waClient = whatsappLinkNode.client;
        var whatsappLiteEvents = config.whatsappLiteevent;
        var whatsappWebEvents = config.whatsappWebevent;

        function SetStatus(WAStatus, color){
            node.status({ fill: color, shape: "dot", text: WAStatus });
        }

        // Function to save base64 data as an image file
        const saveBase64Image = (base64Data, filePath) => {
            const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, '');
            const imageBuffer = Buffer.from(base64Image, 'base64');
            fs.writeFileSync(filePath, imageBuffer);
            node.warn(`Media saved to ${filePath}`);
        };

        // Ensure the base directory exists
        const imagesDir = '/home/om/Saved/nt/WhatsApp/Images/';
        if (!fs.existsSync(imagesDir)) {
            fs.mkdirSync(imagesDir, { recursive: true });
        }

        if (node.waClient.clientType === "waWebClient") {
            whatsappWebEvents = whatsappWebEvents?.split(",") || whatsappWebEvents;
            whatsappWebEvents?.forEach((waEvent) => {
                if (waEvent === 'message') {
                    node.waClient.on(waEvent, async message => {
                        let msg = {};
                        msg.event = waEvent;
                        msg.payload = message.body || null;
                        msg.from = message.author || message.from;
                        msg.chatID = message.from.replace(/\D/g, '');
                        msg.from = msg.from.replace(/\D/g, '');
                        msg.message = message;

                        // Check if the message has media
                        if (message.hasMedia) {
                            const media = await message.downloadMedia();
                            if (media) {
                                const extension = media.mimetype.split('/')[1];
                                const timestamp = Date.now();
                                const userDir = path.join(imagesDir, msg.from);
                                if (!fs.existsSync(userDir)) {
                                    fs.mkdirSync(userDir, { recursive: true });
                                }
                                const filePath = path.join(userDir, `${msg.notifyName}_${msg.from}_${timestamp}_${message.id.id}.${extension}`);
                                saveBase64Image(media.data, filePath);
                            }
                        }

                        node.send(msg);
                    });
                } else {
                    node.waClient.on(waEvent, async message => {
                        let msg = {};
                        msg.event = waEvent;
                        msg.message = message;
                        node.send(msg);
                    });
                }
            });

            // WhatsApp Status Parameters
            node.waClient.on('qr', (qr) => {
                SetStatus("QR Code Generated", "yellow");
            });

            node.waClient.on('auth_failure', () => {
                SetStatus('Not Connected', 'red');
            });

            node.waClient.on('loading_screen', () => {
                SetStatus('Connecting...', 'yellow');
            });

            node.waClient.on('ready', () => {
                SetStatus('Connected', 'green');
            });

            node.waClient.on('disconnected', () => {
                SetStatus("Disconnected", "red");
            });
        } else if (node.waClient.clientType === "waSocketClient") {
            var client = null;

            async function clientFromWhatsappLite() {
                client = await node.waClient;
                whatsappLiteEvents = whatsappLiteEvents?.split(",") || whatsappLiteEvents;
                whatsappLiteEvents?.forEach((waEvent) => {
                    if (waEvent === 'messages.upsert') {
                        client.ev.on('messages.upsert', msgs => {
                            msgs.messages.forEach(async msg => {
                                msg.event = waEvent;
                                msg.payload = msg.message?.conversation;
                                msg.from = msg.key.participant || msg.key.remoteJid;
                                msg.from = msg.from.replace(/\D/g, '') || msg.from;
                                msg.chatID = msg.key.remoteJid.replace(/\D/g, '') || msg.key.remoteJid;
                                if (msg.message.extendedTextMessage) {
                                    return null;
                                }

                                // Check if the message has media
                                if (msg.message && msg.message.imageMessage) {
                                    const media = await client.downloadMediaMessage(msg.message.imageMessage);
                                    if (media) {
                                        const extension = media.mimetype.split('/')[1];
                                        const timestamp = Date.now();
                                        const userDir = path.join(imagesDir, msg.from);
                                        if (!fs.existsSync(userDir)) {
                                            fs.mkdirSync(userDir, { recursive: true });
                                        }
                                        const filePath = path.join(userDir, `${msg.notifyName}_${msg.from}_${timestamp}_${msg.key.id}.${extension}`);
                                        saveBase64Image(media.data, filePath);
                                    }
                                }

                                node.send(msg);
                            });
                        });
                    } else {
                        client.ev.on(waEvent, msgs => {
                            msgs.event = waEvent;
                            node.send(msgs);
                        });
                    }
                });

                // Setting connection status indication
                client.ev.on('connection.update', (updates) => {
                    var { connection } = updates;
                    if (connection === 'open') {
                        SetStatus("Connected", "green");
                    } else if (updates.isOnline) {
                        SetStatus("Connected", "green");
                    } else if (connection === 'close') {
                        SetStatus("Disconnected", "red");
                    } else if (connection === 'connecting') {
                        SetStatus("Connecting...", "yellow");
                    } else if (updates.qr) {
                        SetStatus("Scan QR Code to Connect.", "yellow");
                    }
                });
            }
            clientFromWhatsappLite();
        }
    }
    RED.nodes.registerType("chats-in", WhatsappIn);
}
