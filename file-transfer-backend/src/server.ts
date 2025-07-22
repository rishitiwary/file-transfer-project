// server/src/server.ts
import express from 'express';
import { createServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// --- Type Definitions (Must be consistent with client) ---
interface ChunkManifest {
    index: number;
    size: number;
    md5Hash: string;
}

interface FileManifest {
    fileName: string;
    fileSize: number;
    totalChunks: number;
    chunks: ChunkManifest[];
}

interface WebSocketMessage {
    type: string;
    payload?: any;
    senderId?: string;
    targetId?: string;
}

// --- New Transfer Session Management ---
interface TransferSession {
    transferCode: string;
    senderWs: WebSocket | null;
    receiverWs: WebSocket | null;
    senderId: string | null;
    receiverId: string | null;
    manifest: FileManifest | null;
    receivedChunkCount: number;
    expectedChunks: number;
    fileName: string;
    transferStartTime: number;
}

// --- Server Setup ---
const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const PORT = process.env.PORT || 8080;

const clients = new Map<WebSocket, string>();
const clientIds = new Map<string, WebSocket>();
const sessionsByCode = new Map<string, TransferSession>();


// Serve React build files (uncomment for production deployment)
// app.use(express.static(path.join(__dirname, '../../client/build')));
// app.get('/', (req, res) => {
//     res.sendFile(path.join(__dirname, '../../client/build', 'index.html'));
// });

app.get('/', (req, res) => {
    res.status(200).send('WebSocket File Transfer Server is running!');
});


// --- WebSocket Server Logic ---
wss.on('connection', (ws: WebSocket) => {
    const clientId = uuidv4();
    clients.set(ws, clientId);
    clientIds.set(clientId, ws);
    console.log(`[Server] Client ${clientId} connected.`);

    ws.send(JSON.stringify({ type: 'your-id', payload: clientId }));

    ws.on('message', async (message: Buffer) => {
        let parsedMessage: WebSocketMessage;
        try {
            parsedMessage = JSON.parse(message.toString());
        } catch (e) {
            if (message instanceof Buffer) {
                let session: TransferSession | undefined;
                let currentTransferCode: string | undefined;

                for (const [code, s] of sessionsByCode.entries()) {
                    if (s.senderWs === ws) {
                        session = s;
                        currentTransferCode = code;
                        break;
                    }
                }

                if (session && currentTransferCode) {
                    if (session.receiverWs && session.receiverWs.readyState === WebSocket.OPEN) {
                        session.receiverWs.send(message, { binary: true });
                        session.receivedChunkCount++;
                        if (session.receivedChunkCount % 50 === 0 || session.receivedChunkCount === session.expectedChunks) {
                            console.log(`[Server] Transfer ${currentTransferCode}: Relayed ${session.receivedChunkCount}/${session.expectedChunks} chunks (binary) to receiver.`);
                        }
                    } else {
                        console.warn(`[Server] Binary chunk for ${currentTransferCode} received from ${clientId}, but receiver is not open. Discarding chunk.`);
                    }
                } else {
                    console.warn(`[Server] Received unassociated binary message from ${clientId}. No active transfer session found for this sender.`);
                }
            } else {
                console.error(`[Server] Client ${clientId}: Failed to parse message. Not JSON and not Buffer.`);
            }
            return;
        }

        console.log(`[Server] Client ${clientId} received message type: ${parsedMessage.type}`);

        switch (parsedMessage.type) {
            case 'register-peer':
                break;

            case 'initiate-transfer':
                const { transferCode, manifest } = parsedMessage.payload;

                if (!transferCode || !manifest) {
                    ws.send(JSON.stringify({ type: 'transfer-error', payload: 'Transfer code or manifest missing.' }));
                    console.warn(`[Server] Client ${clientId}: Initiate transfer failed - missing code or manifest.`);
                    return;
                }

                let session = sessionsByCode.get(transferCode);

                if (session) {
                    session.senderWs = ws;
                    session.senderId = clientId;
                    session.manifest = manifest;
                    session.expectedChunks = manifest.totalChunks;
                    session.fileName = manifest.fileName;
                    session.receivedChunkCount = 0;
                    session.transferStartTime = Date.now();
                    console.log(`[Server] Client ${clientId}: Sender re-initiated/joined existing transfer session for code: ${transferCode}.`);

                    ws.send(JSON.stringify({
                        type: 'transfer-initiated',
                        payload: { transferId: transferCode }
                    }));

                    if (session.receiverWs && session.receiverWs.readyState === WebSocket.OPEN) {
                        console.log(`[Server] Transfer ${transferCode}: Informing receiver ${session.receiverId} about re-initiated transfer.`);
                        session.receiverWs.send(JSON.stringify({
                            type: 'incoming-transfer',
                            payload: {
                                transferId: transferCode,
                                senderId: clientId,
                                manifest: manifest
                            }
                        }));
                    } else {
                         console.log(`[Server] Receiver for code ${transferCode} (Client ${session.receiverId}) is not yet open or connected.`);
                    }

                } else {
                    session = {
                        transferCode: transferCode,
                        senderWs: ws,
                        receiverWs: null,
                        senderId: clientId,
                        receiverId: null,
                        manifest: manifest,
                        receivedChunkCount: 0,
                        expectedChunks: manifest.totalChunks,
                        fileName: manifest.fileName,
                        transferStartTime: Date.now(),
                    };
                    sessionsByCode.set(transferCode, session);
                    console.log(`[Server] Client ${clientId}: New transfer session created for code: ${transferCode}. File: ${manifest.fileName}`);
                    ws.send(JSON.stringify({
                        type: 'transfer-initiated',
                        payload: { transferId: transferCode }
                    }));
                }
                break;

            case 'join-transfer':
                const { transferCode: joinCode } = parsedMessage.payload;
                if (!joinCode) {
                    ws.send(JSON.stringify({ type: 'error', payload: 'Join code missing.' }));
                    console.warn(`[Server] Client ${clientId}: Join transfer failed - missing code.`);
                    return;
                }

                let joinSession = sessionsByCode.get(joinCode);

                if (joinSession) {
                    joinSession.receiverWs = ws;
                    joinSession.receiverId = clientId;
                    console.log(`[Server] Client ${clientId}: Receiver joined transfer session for code: ${joinCode}.`);

                    if (joinSession.manifest) {
                        console.log(`[Server] Receiver ${clientId} for code ${joinCode} joined. Sending manifest immediately.`);
                        ws.send(JSON.stringify({
                            type: 'incoming-transfer',
                            payload: {
                                transferId: joinCode,
                                senderId: joinSession.senderId || 'unknown',
                                manifest: joinSession.manifest
                            }
                        }));
                    } else {
                        console.log(`[Server] Receiver ${clientId} for code ${joinCode} joined, but no manifest yet. Sending wait message.`);
                        ws.send(JSON.stringify({
                            type: 'wait-for-sender',
                            payload: { message: `Waiting for sender to initiate transfer with code: ${joinCode}` }
                        }));
                    }

                    if (joinSession.senderWs && joinSession.senderWs.readyState === WebSocket.OPEN) {
                        console.log(`[Server] Transfer ${joinCode}: Notifying sender ${joinSession.senderId} that receiver ${clientId} joined.`);
                        joinSession.senderWs.send(JSON.stringify({
                            type: 'receiver-joined',
                            payload: { transferId: joinCode, receiverId: clientId }
                        }));
                    }
                } else {
                    sessionsByCode.set(joinCode, {
                        transferCode: joinCode,
                        senderWs: null,
                        receiverWs: ws,
                        senderId: null,
                        receiverId: clientId,
                        manifest: null,
                        receivedChunkCount: 0,
                        expectedChunks: 0,
                        fileName: 'N/A',
                        transferStartTime: 0,
                    });
                    console.log(`[Server] Client ${clientId}: Receiver created a new, waiting transfer session for code: ${joinCode}.`);
                    ws.send(JSON.stringify({
                        type: 'wait-for-sender',
                        payload: { message: `Waiting for sender to initiate transfer with code: ${joinCode}` }
                    }));
                }
                break;

            case 'chunk-metadata':
                const { transferCode: metaTransferCode, chunkIndex, originalMd5 } = parsedMessage.payload;
                const metaSession = sessionsByCode.get(metaTransferCode);

                if (metaSession && metaSession.receiverWs && metaSession.receiverWs.readyState === WebSocket.OPEN) {
                    console.log(`[Server] Relaying chunk-metadata for code ${metaTransferCode}, index ${chunkIndex} to receiver ${metaSession.receiverId}.`);
                    metaSession.receiverWs.send(JSON.stringify({
                        type: 'chunk-metadata',
                        payload: {
                            transferId: metaTransferCode,
                            chunkIndex: chunkIndex,
                            originalMd5: originalMd5
                        }
                    }));
                } else {
                    console.warn(`[Server] Could not relay chunk-metadata for code ${metaTransferCode} (Chunk: ${chunkIndex}) from sender ${clientId}. Receiver not ready or session not found.`);
                }
                break;

            case 'transfer-complete-sender':
                const { transferId: senderCompleteTransferId } = parsedMessage.payload;
                const senderCompleteSession = sessionsByCode.get(senderCompleteTransferId);
                if (senderCompleteSession) {
                    console.log(`[Server] Sender ${clientId} for transfer ${senderCompleteTransferId} indicated completion.`);
                    if (senderCompleteSession.receiverWs && senderCompleteSession.receiverWs.readyState === WebSocket.OPEN) {
                        console.log(`[Server] Notifying receiver ${senderCompleteSession.receiverId} that sender completed for ${senderCompleteTransferId}.`);
                        senderCompleteSession.receiverWs.send(JSON.stringify({
                            type: 'transfer-complete-server-signal',
                            payload: { transferId: senderCompleteTransferId }
                        }));
                    } else {
                        console.warn(`[Server] Sender completed for ${senderCompleteTransferId}, but no active receiver to notify.`);
                    }
                }
                break;

            case 'transfer-complete-receiver':
                const { transferId: receiverCompleteTransferId } = parsedMessage.payload;
                const receiverCompleteSession = sessionsByCode.get(receiverCompleteTransferId);
                if (receiverCompleteSession) {
                    console.log(`[Server] Receiver ${clientId} for transfer ${receiverCompleteTransferId} indicated completion (reassembly).`);
                    if (receiverCompleteSession.senderWs && receiverCompleteSession.senderWs.readyState === WebSocket.OPEN) {
                        console.log(`[Server] Notifying sender ${receiverCompleteSession.senderId} that transfer ${receiverCompleteTransferId} is finalized.`);
                        receiverCompleteSession.senderWs.send(JSON.stringify({
                            type: 'transfer-finalized',
                            payload: { transferId: receiverCompleteTransferId, status: 'success' }
                        }));
                    }
                    if (receiverCompleteSession.receiverWs && receiverCompleteSession.receiverWs.readyState === WebSocket.OPEN) {
                        console.log(`[Server] Notifying receiver ${receiverCompleteSession.receiverId} that transfer ${receiverCompleteTransferId} is finalized.`);
                        receiverCompleteSession.receiverWs.send(JSON.stringify({
                            type: 'transfer-finalized',
                            payload: { transferId: receiverCompleteTransferId, status: 'success' }
                        }));
                    }
                    sessionsByCode.delete(receiverCompleteTransferId);
                    console.log(`[Server] Transfer session ${receiverCompleteTransferId} finalized and cleaned up.`);
                }
                break;

            case 'transfer-aborted':
                const { transferId: abortedTransferId, reason } = parsedMessage.payload;
                const abortedSession = sessionsByCode.get(abortedTransferId);
                if (abortedSession) {
                    console.log(`[Server] Transfer ${abortedTransferId} explicitly aborted by client ${clientId}. Reason: ${reason}`);
                    if (abortedSession.senderWs && abortedSession.senderWs !== ws && abortedSession.senderWs.readyState === WebSocket.OPEN) {
                        abortedSession.senderWs.send(JSON.stringify({ type: 'transfer-aborted', payload: { transferId: abortedTransferId, reason: `Other side aborted: ${reason}` } }));
                    }
                    if (abortedSession.receiverWs && abortedSession.receiverWs !== ws && abortedSession.receiverWs.readyState === WebSocket.OPEN) {
                        abortedSession.receiverWs.send(JSON.stringify({ type: 'transfer-aborted', payload: { transferId: abortedTransferId, reason: `Other side aborted: ${reason}` } }));
                    }
                    sessionsByCode.delete(abortedTransferId);
                    console.log(`[Server] Transfer session ${abortedTransferId} aborted and cleaned up.`);
                }
                break;

            case 'retransmit-chunk':
                console.warn(`[Server] Retransmit chunk request received but not fully implemented.`);
                break;

            default:
                console.warn(`[Server] Client ${clientId}: Unknown message type: ${parsedMessage.type}`, parsedMessage);
        }
    });

    // FIX APPLIED HERE: Explicitly type the 'event' parameter for the 'close' event
    ws.on('close', (event: { code: number; reason: string; wasClean: boolean }) => {
        const clientId = clients.get(ws);
        if (clientId) {
            console.log(`[Server] Client ${clientId} disconnected. Code: ${event.code}, Reason: ${event.reason || 'No reason'}.`);
            clients.delete(ws);
            clientIds.delete(clientId);

            sessionsByCode.forEach((session, transferCode) => {
                let sessionUpdated = false;
                if (session.senderWs === ws) {
                    session.senderWs = null;
                    console.log(`[Server] Sender for transfer ${transferCode} (Client ${clientId}) disconnected.`);
                    sessionUpdated = true;
                } else if (session.receiverWs === ws) {
                    session.receiverWs = null;
                    console.log(`[Server] Receiver for transfer ${transferCode} (Client ${clientId}) disconnected.`);
                    sessionUpdated = true;
                }

                if (sessionUpdated) {
                    if (!session.senderWs && session.receiverWs && session.receiverWs.readyState === WebSocket.OPEN) {
                        session.receiverWs.send(JSON.stringify({ type: 'transfer-aborted', payload: { transferId: transferCode, reason: 'Sender disconnected' } }));
                        console.log(`[Server] Notified receiver ${session.receiverId} that sender ${clientId} disconnected for transfer ${transferCode}.`);
                    } else if (!session.receiverWs && session.senderWs && session.senderWs.readyState === WebSocket.OPEN) {
                        session.senderWs.send(JSON.stringify({ type: 'transfer-aborted', payload: { transferId: transferCode, reason: 'Receiver disconnected' } }));
                        console.log(`[Server] Notified sender ${session.senderId} that receiver ${clientId} disconnected for transfer ${transferCode}.`);
                    } else if (!session.senderWs && !session.receiverWs) {
                        sessionsByCode.delete(transferCode);
                        console.log(`[Server] Transfer ${transferCode} session fully cleaned up due to both parties disconnecting.`);
                    }
                }
            });
        }
    });

    ws.on('error', (error) => {
        const clientId = clients.get(ws) || 'unknown';
        console.error(`[Server] Client ${clientId} WebSocket error:`, error);
        ws.close(1011, "Unexpected error occurred");
    });
});

httpServer.listen(PORT, () => {
    console.log(`WebSocket File Transfer Server is running on http://localhost:${PORT}`);
});