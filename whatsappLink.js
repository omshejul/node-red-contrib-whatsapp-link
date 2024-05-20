module.exports = function(RED) {
    const QRCode = require('qrcode');
    const FS = require('node:fs');
    const OS = require('os');
    const Path = require('path');
    let userDir = OS.homedir();
    let whatsappLinkDir = Path.join(userDir, '.node-red', 'Whatsapp-Link');
    let whatsappLinkDirSocket = Path.join(whatsappLinkDir, 'WA-Sockets');

    function RemoteClientNode(n) {
        RED.nodes.createNode(this, n);
        var WAnode = this;
        var clientType = n.clientType;
        var loopTime = n.loopTime;
        loopTime = loopTime + Math.random();
        loopTime = loopTime * 60 * 60 * 1000 || 3600000;
        var onlineStatus = n.onlineStatus;
        var whatsappConnectionStatus;
        var client;

        if (clientType === "waWebClient") {
            const { Client, LocalAuth } = require('whatsapp-web.js');

            var WAConnect = function() {
                const webClient = new Client({
                    authStrategy: new LocalAuth({
                        dataPath: Path.join(whatsappLinkDir, WAnode.id) // Ensure unique session directory
                    }),
                    puppeteer: {
                        headless: true,
                        args: ['--no-sandbox', '--disable-setuid-sandbox', '--user-data-dir=' + Path.join(OS.tmpdir(), 'puppeteer_' + WAnode.id)]
                    }
                });

                webClient.on('qr', (qr) => {
                    QRCode.toString(qr, { type: 'terminal', small: true }, function(err, QRTerminal) {
                        if (err) {
                            WAnode.error(`QR Code generation error: ${err}`);
                            return;
                        }
                        WAnode.log(`To Connect, Scan the QR Code through your Whatsapp Mobile App.`);
                        console.log(QRTerminal);
                    });
                });

                webClient.on('ready', () => {
                    WAnode.log(`Status: Whatsapp Connected`);
                    pressenceUpdate(onlineStatus);
                });

                webClient.on('authenticated', () => {
                    WAnode.log('Status: Authenticated');
                });

                webClient.on('auth_failure', (msg) => {
                    WAnode.error('AUTHENTICATION FAILURE', msg);
                });

                webClient.on('disconnected', (reason) => {
                    WAnode.log('Client was logged out', reason);
                });

                webClient.initialize().catch(e => {
                    WAnode.error(`Error: Unable to start Whatsapp. Try Again. ${e}`);
                });

                return webClient;
            };
            client = WAConnect();

            async function pressenceUpdate(OLS) {
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

            function WAClose() {
                try {
                    client.destroy();
                } catch (e) {
                    WAnode.error(`Error: Too many instructions! Try again. ${e}`);
                }
            };

            var WARestart = function() {
                WAClose();
                client = WAConnect();
            }

            async function connectionSetup() {
                try {
                    whatsappConnectionStatus = await client.getState();
                    if (whatsappConnectionStatus === "CONNECTED") {
                        clearInterval(WAnode.connectionSetupID);
                    } else {
                        WAnode.log(`Status: Connecting to Whatsapp...`);
                    }
                } catch (e) {
                    WAnode.log(`Error: Waiting for Initialization...`);
                }
            };
            WAnode.connectionSetupID = setInterval(connectionSetup, 10000);

            client.WAConnect = WAConnect;
            client.WARestart = WARestart;
            client.WAClose = WAClose;
            client.clientType = clientType;
            WAnode.client = client;
        }

        if (clientType === "waSocketClient") {
            const makeWASocket = require('@whiskeysockets/baileys');
            const { useMultiFileAuthState } = makeWASocket;
            const pino = require('pino');

            async function connectSocketClient() {
                const { state, saveCreds } = await useMultiFileAuthState(whatsappLinkDirSocket);
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
                                connectSocketClient();
                            } else if ([401, 440].includes(statusCode)) {
                                FS.rmSync(whatsappLinkDirSocket, { recursive: true, force: true });
                                connectSocketClient();
                            } else {
                                WAnode.log(`ErrorCode: ${statusCode} | ${lastDisconnect.error}`);
                            }
                        }
                    }
                });
                return socketClient;
            }
            client = connectSocketClient();
            client.onlineStatus = onlineStatus;
            client.clientType = clientType;
            client.clientStartFunction = connectSocketClient;
            WAnode.client = client;
        }

        async function loopStatusUpdate() {
            try {
                if (clientType === "waSocketClient") {
                    let myClient = await WAnode.client;
                    let id = myClient.user.id;
                    await myClient.sendPresenceUpdate("available", id);
                    if (!onlineStatus) {
                        setTimeout(() => {
                            myClient.sendPresenceUpdate("unavailable", id);
                        }, 17000);
                    }
                } else {
                    await WAnode.client.sendPresenceAvailable();
                    if (!onlineStatus) {
                        setTimeout(() => {
                            WAnode.client.sendPresenceUnavailable();
                        }, 17000);
                    }
                }
            } catch (e) {
                WAnode.error("Error in whatsapp Ping.");
            }
        }

        var loopStatusUpdateID = setInterval(() => {
            loopStatusUpdate();
        }, loopTime);

        this.on('close', (removed, done) => {
            clearInterval(loopStatusUpdateID);
            if (removed) {
                if (clientType === "waWebClient") {
                    clearInterval(WAnode.connectionSetupID);
                    WAnode.client.WAClose();
                } else {
                    WAnode.client.end();
                }
            } else {
                if (clientType === "waWebClient") {
                    clearInterval(WAnode.connectionSetupID);
                    WAnode.client.WAClose();
                } else {
                    WAnode.client.end();
                }
            }
            done();
        });
    }
    RED.nodes.registerType("whatsappLink", RemoteClientNode);
}
