const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const os = require('os');
const puppeteer = require('puppeteer');
const { Client, LocalAuth } = require('whatsapp-web.js');
const makeWASocket = require('@whiskeysockets/baileys');
const pino = require('pino');

const userDir = os.homedir();
const whatsappLinkDir = path.join(userDir, '.node-red', 'Whatsapp-Link');
const whatsappLinkDirSocket = path.join(whatsappLinkDir, 'WA-Sockets');

module.exports = function(RED) {
    function RemoteClientNode(n) {
        RED.nodes.createNode(this, n);
        const WAnode = this;
        const clientType = n.clientType;
        const loopTime = (n.loopTime + Math.random()) * 60 * 60 * 1000 || 3600000;
        const onlineStatus = n.onlineStatus;
        const clients = {};
        const clientIds = n.clientIds ? n.clientIds.split(',') : []; // Fetch client IDs from node configuration

        function SetStatus(WAStatus, color) {
            WAnode.status({ fill: color, shape: "dot", text: WAStatus });
        }

        async function createWebClient(clientId) {
            const browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--user-data-dir=' + path.join(os.tmpdir(), 'puppeteer_' + clientId)]
            });

            const client = new Client({
                authStrategy: new LocalAuth({
                    dataPath: path.join(whatsappLinkDir, clientId) // Ensure unique session directory
                }),
                puppeteer: { browser }
            });

            client.on('qr', (qr) => {
                QRCode.toString(qr, { type: 'terminal', small: true }, function(err, QRTerminal) {
                    if (err) {
                        WAnode.error(`QR Code generation error: ${err}`);
                        return;
                    }
                    WAnode.log(`To Connect, Scan the QR Code through your Whatsapp Mobile App.`);
                    console.log(QRTerminal);
                });
            });

            client.on('ready', () => {
                WAnode.log(`Status: Whatsapp Connected`);
                pressenceUpdate(client, onlineStatus);
            });

            client.on('authenticated', () => {
                WAnode.log('Status: Authenticated');
            });

            client.on('auth_failure', (msg) => {
                WAnode.error('AUTHENTICATION FAILURE', msg);
            });

            client.on('disconnected', (reason) => {
                WAnode.log('Client was logged out', reason);
            });

            await client.initialize().catch(e => {
                WAnode.error(`Error: Unable to start Whatsapp. Try Again. ${e}`);
            });

            return client;
        }

        async function createSocketClient(clientId) {
            const { state, saveCreds } = await makeWASocket.useMultiFileAuthState(path.join(whatsappLinkDirSocket, clientId));
            const socketClient = makeWASocket.default({
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                auth: state,
                browser: ["Node-RED", "Chrome", "4.0.0"],
                markOnlineOnConnect: onlineStatus,
                patchMessageBeforeSending: (message) => {
                    const requiresPatch = !!(message.buttonsMessage || message.templateMessage || message.listMessage);
                    if (requiresPatch) {
                        message = {
                            viewOnceMessage: {
                                message: {
                                    messageContextInfo: {
                                        deviceListMetadataVersion: 2,
                                        deviceListMetadata: {},
                                    },
                                    ...message,
                                },
                            },
                        };
                    }
                    return message;
                },
            });

            socketClient.ev.on('creds.update', saveCreds);

            socketClient.ev.on('connection.update', (update) => {
                const { connection, lastDisconnect } = update;
                if (connection === 'close') {
                    if (lastDisconnect && lastDisconnect.error && lastDisconnect.error.output) {
                        const statusCode = lastDisconnect.error.output.statusCode;
                        if ([410, 428, 515].includes(statusCode)) {
                            createSocketClient(clientId);
                        } else if ([401, 440].includes(statusCode)) {
                            fs.rmSync(path.join(whatsappLinkDirSocket, clientId), { recursive: true, force: true });
                            createSocketClient(clientId);
                        } else {
                            WAnode.log(`ErrorCode: ${statusCode} | ${lastDisconnect.error}`);
                        }
                    }
                }
            });

            return socketClient;
        }

        async function pressenceUpdate(client, OLS) {
            try {
                if (!OLS) {
                    await client.sendPresenceUnavailable();
                    WAnode.log(`Whatsapp marked as Offline`);
                } else {
                    await client.sendPresenceAvailable();
                }
            } catch (e) {
                WAnode.error("Error at presence: " + e);
            }
        }

        async function initializeClients(clientIds) {
            for (const clientId of clientIds) {
                if (clientType === "waWebClient") {
                    clients[clientId] = await createWebClient(clientId);
                } else if (clientType === "waSocketClient") {
                    clients[clientId] = await createSocketClient(clientId);
                }
            }
        }

        async function loopStatusUpdate() {
            try {
                for (const clientId in clients) {
                    const client = clients[clientId];
                    if (clientType === "waSocketClient") {
                        let id = client.user.id;
                        await client.sendPresenceUpdate("available", id);
                        if (!onlineStatus) {
                            setTimeout(() => {
                                client.sendPresenceUpdate("unavailable", id);
                            }, 17000);
                        }
                    } else {
                        await client.sendPresenceAvailable();
                        if (!onlineStatus) {
                            setTimeout(() => {
                                client.sendPresenceUnavailable();
                            }, 17000);
                        }
                    }
                }
            } catch (e) {
                WAnode.error("Error in whatsapp Ping.");
            }
        }

        const loopStatusUpdateID = setInterval(loopStatusUpdate, loopTime);

        this.on('close', (removed, done) => {
            clearInterval(loopStatusUpdateID);
            for (const clientId in clients) {
                const client = clients[clientId];
                if (clientType === "waWebClient") {
                    client.destroy();
                } else {
                    client.end();
                }
            }
            done();
        });

        // Initialize clients using IDs provided in the node configuration
        if (clientIds.length > 0) {
            initializeClients(clientIds);
        } else {
            WAnode.error('No client IDs provided');
        }
    }

    RED.nodes.registerType("whatsappLink", RemoteClientNode);
}
