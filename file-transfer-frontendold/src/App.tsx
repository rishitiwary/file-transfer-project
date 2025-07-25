import React, { useState, useEffect, useRef, useCallback } from 'react';
import CryptoJS from 'crypto-js';
import './index.css';

// Type definitions - Ensure consistency with server
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
    senderId?: string; // Client's own ID, useful for server to identify
    targetId?: string; // Not directly used for targeting in this model
}

const CHUNK_SIZE = 100 * 1024 * 1024; // 100 MB per chunk

const App: React.FC = () => {
    const [myId, setMyId] = useState<string | null>(null);
    const [role, setRole] = useState<'sender' | 'receiver'>('sender');
    const [transferCode, setTransferCode] = useState<string>('');
    const [fileToSend, setFileToSend] = useState<File | null>(null);
    const [log, setLog] = useState<string[]>([]);
    const [currentTransferId, setCurrentTransferId] = useState<string | null>(null);
    const [receivedManifest, setReceivedManifest] = useState<FileManifest | null>(null);
    const [receivedChunksMap, setReceivedChunksMap] = useState<Map<number, Blob>>(new Map());
    const [transferProgress, setTransferProgress] = useState(0);
    const [transferSpeed, setTransferSpeed] = useState<string | null>(null);
    const [isConnected, setIsConnected] = useState(false); // New state to track WebSocket connection status
    const [showDownloadPrompt, setShowDownloadPrompt] = useState(false); // New state for download prompt

    const wsRef = useRef<WebSocket | null>(null);
    const fileManifestRef = useRef<FileManifest | null>(null);
    const fileWriterRef = useRef<FileSystemWritableFileStream | null>(null);
    const chunkSentTime = useRef<Map<number, number>>(new Map());
    const totalBytesSent = useRef<number>(0);
    const transferStartTime = useRef<number | null>(null);

    // Callback to add logs to the UI
    const addLog = useCallback((message: string) => {
        setLog((prev) => [...prev, `${new Date().toLocaleTimeString()} - ${message}`]);
    }, []);

    // Function to reset all transfer-specific states
    const resetTransferStates = useCallback(async () => {
        addLog('Resetting transfer-specific states...'); // Added more specific log
        setCurrentTransferId(null);
        setReceivedManifest(null);
        setReceivedChunksMap(new Map());
        setTransferProgress(0);
        setTransferSpeed(null);
        transferStartTime.current = null;
        totalBytesSent.current = 0;
        chunkSentTime.current.clear();
        setShowDownloadPrompt(false); // Reset download prompt visibility
        if (fileWriterRef.current) {
            try {
                await fileWriterRef.current.close();
                addLog('File writer closed successfully during reset.');
            } catch (e) {
                console.error("Error closing file writer during reset:", e);
                addLog(`Error closing file writer during reset: ${(e as Error).message}`);
            } finally {
                fileWriterRef.current = null;
            }
        }
        addLog('Transfer states reset complete.');
    }, [addLog]);

    // Function to reassemble and save the received file
    const reassembleFile = useCallback(async () => { // Removed manifest, chunksMap, currentTransferCode from params
        if (!receivedManifest || !currentTransferId) {
            addLog('Error: Cannot reassemble file. Manifest or transfer ID missing.');
            return;
        }

        addLog('Reassembling file...');
        const sortedChunks: Blob[] = [];
        let allChunksPresent = true;
        for (let i = 0; i < receivedManifest.totalChunks; i++) {
            const chunk = receivedChunksMap.get(i);
            if (chunk) {
                sortedChunks.push(chunk);
            } else {
                addLog(`Missing chunk ${i}. Reassembly incomplete.`);
                allChunksPresent = false;
                break;
            }
        }

        if (!allChunksPresent) {
            addLog('Not all chunks received, reassembly aborted.');
            wsRef.current?.send(JSON.stringify({
                type: 'transfer-aborted',
                payload: { transferId: currentTransferId, reason: `Receiver missing chunks during reassembly` }
            }));
            resetTransferStates();
            return;
        }

        try {
            // Attempt to use File System Access API first
            if ('showSaveFilePicker' in window) {
                addLog('Attempting to save file via File System Access API...');
                try {
                    const handle = await (window as any).showSaveFilePicker({
                        suggestedName: receivedManifest.fileName,
                        types: [{ description: 'All Files', accept: { 'application/octet-stream': ['.*'] }, }],
                    });
                    fileWriterRef.current = await handle.createWritable();
                    // Add null check here before using fileWriterRef.current
                    if (fileWriterRef.current) {
                        for (const chunk of sortedChunks) {
                            await fileWriterRef.current.write(chunk);
                        }
                        await fileWriterRef.current.close();
                        fileWriterRef.current = null;
                        addLog(`File "${receivedManifest.fileName}" successfully reassembled and saved to disk.`);
                    } else {
                        // This else block handles cases where createWritable() might return null
                        // (though typically it would throw an error if it fails).
                        addLog('File writer could not be created. Falling back to in-memory download.');
                        const completeBlob = new Blob(sortedChunks, { type: 'application/octet-stream' });
                        const url = URL.createObjectURL(completeBlob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = receivedManifest.fileName;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                        addLog(`File "${receivedManifest.fileName}" reassembled. Download initiated. Check your browser's download folder.`);
                    }
                } catch (err: any) {
                    addLog(`Error saving file via File System Access API: ${err.name || err.message}. Falling back to in-memory download.`);
                    fileWriterRef.current = null; // Ensure it's null if failed
                    // Fallback to in-memory download
                    const completeBlob = new Blob(sortedChunks, { type: 'application/octet-stream' });
                    const url = URL.createObjectURL(completeBlob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = receivedManifest.fileName;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    addLog(`File "${receivedManifest.fileName}" reassembled. Download initiated. Check your browser's download folder.`);
                }
            } else {
                // Fallback for browsers not supporting File System Access API
                addLog('File System Access API not supported. Reassembling file in memory...');
                const completeBlob = new Blob(sortedChunks, { type: 'application/octet-stream' });
                const url = URL.createObjectURL(completeBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = receivedManifest.fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                addLog(`File "${receivedManifest.fileName}" reassembled. Download initiated. Check your browser's download folder.`);
            }


            if (transferStartTime.current) {
                const duration = (Date.now() - transferStartTime.current) / 1000;
                const fileSizeMB = receivedManifest.fileSize / (1024 * 1024);
                const speed = (fileSizeMB / duration).toFixed(2);
                setTransferSpeed(`${speed} MB/s`);
                addLog(`Transfer finished in ${duration.toFixed(2)}s. Speed: ${speed} MB/s`);
            }

            wsRef.current?.send(JSON.stringify({
                type: 'transfer-complete-receiver',
                payload: { transferId: currentTransferId }
            }));

        } catch (error: any) {
            addLog(`Error during file reassembly/saving: ${error.message || error}`);
            console.error("Error during file reassembly/saving:", error);
            if (fileWriterRef.current) {
                try {
                    if (typeof fileWriterRef.current.abort === 'function') {
                        await fileWriterRef.current.abort();
                        addLog('File writer aborted due to error.');
                    } else {
                        await fileWriterRef.current.close();
                        addLog('File writer closed due to error.');
                    }
                } catch (e) {
                    console.error("Error handling file writer on reassembly error:", e);
                } finally {
                    fileWriterRef.current = null;
                }
            }
            wsRef.current?.send(JSON.stringify({
                type: 'transfer-aborted',
                payload: { transferId: currentTransferId, reason: `Receiver reassembly error: ${error.message || error}` }
            }));
            resetTransferStates();
        } finally {
            setShowDownloadPrompt(false); // Hide the prompt after attempting download
        }
    }, [addLog, resetTransferStates, receivedManifest, receivedChunksMap, currentTransferId]); // Added receivedManifest, receivedChunksMap, currentTransferId to dependencies

    // --- WebSocket Connection and Message Handling ---
    useEffect(() => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            addLog('WebSocket already connected. Skipping new connection.');
            return;
        }

        addLog('Attempting to establish new WebSocket connection...');
        const ws = new WebSocket('ws://localhost:8080');
        wsRef.current = ws;

        ws.onopen = () => {
            addLog('Connected to server.');
            setIsConnected(true);
            ws.send(JSON.stringify({ type: 'register-peer' }));
            if (role === 'receiver' && transferCode && currentTransferId === null) {
                addLog(`Attempting to join transfer code: ${transferCode} on connection open.`);
                ws.send(JSON.stringify({ type: 'join-transfer', payload: { transferCode: transferCode } }));
            }
        };

        ws.onmessage = async (event) => {
            if (typeof event.data === 'string') {
                try {
                    const message: WebSocketMessage = JSON.parse(event.data);

                    switch (message.type) {
                        case 'your-id':
                            setMyId(message.payload);
                            addLog(`My Peer ID: ${message.payload}`);
                            break;

                        case 'transfer-initiated':
                            const { transferId: senderTransferId } = message.payload;
                            setCurrentTransferId(senderTransferId);
                            addLog(`Transfer initiated with ID: ${senderTransferId}`);
                            transferStartTime.current = Date.now();
                            if (role === 'sender' && fileToSend && fileManifestRef.current) {
                                sendAllChunks(fileToSend, fileManifestRef.current, senderTransferId);
                            }
                            break;

                        case 'receiver-joined':
                            addLog(`Receiver ${message.payload.receiverId} joined transfer code: ${message.payload.transferId}`);
                            break;

                        case 'incoming-transfer':
                            if (role === 'receiver') {
                                const { transferId: incomingTransferId, senderId, manifest } = message.payload;

                                if (currentTransferId && currentTransferId !== incomingTransferId) {
                                    addLog(`Ignoring incoming transfer ${incomingTransferId}. Already active on ${currentTransferId}.`);
                                    return;
                                }

                                if (currentTransferId !== incomingTransferId || !receivedManifest || receivedManifest.fileName !== manifest.fileName || receivedManifest.totalChunks !== manifest.totalChunks) {
                                    setReceivedManifest(manifest);
                                    setReceivedChunksMap(new Map());
                                    setTransferProgress(0);
                                    setTransferSpeed(null);
                                    transferStartTime.current = Date.now();
                                    addLog(`Incoming transfer from ${senderId} (ID: ${incomingTransferId}). File: ${manifest.fileName} (${(manifest.fileSize / (1024 * 1024)).toFixed(2)} MB)`);
                                    addLog(`Expecting ${manifest.totalChunks} chunks.`);
                                    setCurrentTransferId(incomingTransferId);
                                    // Do NOT call showSaveFilePicker here. It will be called from a user gesture later.
                                } else {
                                    addLog(`Re-initiation detected for transfer ${incomingTransferId}. Manifest seems consistent. Continuing existing transfer.`);
                                }
                            }
                            break;

                        case 'wait-for-sender':
                            if (role === 'receiver') {
                                addLog(`Server: ${message.payload.message}`);
                                setReceivedManifest(null);
                                setReceivedChunksMap(new Map());
                                setTransferProgress(0);
                                setTransferSpeed(null);
                            }
                            break;

                        case 'retransmit-chunk':
                            if (role === 'sender' && fileToSend && fileManifestRef.current && currentTransferId) {
                                const { transferId, chunkIndex } = message.payload;
                                if (transferId === currentTransferId) {
                                    addLog(`Server requested re-sending chunk ${chunkIndex}.`);
                                    sendChunk(fileToSend, fileManifestRef.current, currentTransferId, chunkIndex);
                                }
                            }
                            break;

                        case 'transfer-complete-server-signal':
                            addLog('Server indicated sender completed. Waiting for full reassembly at receiver.');
                            break;

                        case 'transfer-finalized':
                            addLog(`Transfer ${message.payload.transferId} finalized by server.`);
                            resetTransferStates();
                            break;

                        case 'transfer-aborted':
                            addLog(`Transfer ${message.payload.transferId} aborted: ${message.payload.reason}.`);
                            resetTransferStates();
                            break;

                        default:
                            console.warn('Unknown JSON message type:', message.type, message);
                    }
                } catch (e: any) {
                    addLog(`Error parsing JSON message: ${e.message}. Data: ${event.data?.toString().substring(0, 200) || 'N/A'}...`);
                    console.error("Error parsing JSON message:", e);
                }
            } else if (event.data instanceof Blob) {
                if (role === 'receiver' && currentTransferId && receivedManifest) {
                    const chunkData = event.data;
                    try {
                        const arrayBuffer = await chunkData.arrayBuffer();
                        const wordArray = CryptoJS.lib.WordArray.create(arrayBuffer);
                        const receivedMd5Hash = CryptoJS.MD5(wordArray).toString();

                        const expectedChunk = receivedManifest.chunks.find(
                            (c) => c.md5Hash === receivedMd5Hash && !receivedChunksMap.has(c.index)
                        );

                        if (expectedChunk) {
                            setReceivedChunksMap((prev) => {
                                const newMap = new Map(prev).set(expectedChunk.index, chunkData);
                                const progress = (newMap.size / receivedManifest.totalChunks) * 100;
                                setTransferProgress(progress);
                                addLog(`Receiver: Received chunk ${expectedChunk.index + 1}/${receivedManifest.totalChunks}. Current progress: ${progress.toFixed(2)}%`);

                                if (transferStartTime.current) {
                                    const duration = (Date.now() - transferStartTime.current) / 1000;
                                    if (duration > 0) {
                                        const receivedBytes = Array.from(newMap.values()).reduce((sum, blob) => sum + blob.size, 0);
                                        const speedMBps = (receivedBytes / (1024 * 1024)) / duration;
                                        setTransferSpeed(`${speedMBps.toFixed(2)} MB/s`);
                                    }
                                }

                                if (newMap.size === receivedManifest.totalChunks) {
                                    addLog('All chunks received! Prompting user to download...');
                                    setShowDownloadPrompt(true); // Show the download button
                                    // Do NOT call reassembleFile here directly
                                }
                                return newMap;
                            });
                        } else {
                            addLog(`Receiver: Received binary chunk with MD5 ${receivedMd5Hash} (size: ${chunkData.size}). Unable to match or already received.`);
                        }
                    } catch (blobError: any) {
                        addLog(`Receiver: Error processing binary chunk: ${blobError.message || blobError}`);
                        console.error("Error processing binary chunk:", blobError);
                        wsRef.current?.send(JSON.stringify({
                            type: 'transfer-aborted',
                            payload: { transferId: currentTransferId, reason: `Receiver chunk processing error: ${blobError.message || blobError}` }
                        }));
                        resetTransferStates();
                    }
                } else {
                    addLog(`Receiver: Received binary chunk but not in active transfer state or manifest not loaded.
                            Role: ${role}, CurrentTransferId: ${currentTransferId}, Manifest loaded: ${!!receivedManifest},
                            Received Map Size: ${receivedChunksMap.size}, Expected Chunks: ${receivedManifest?.totalChunks || 'N/A'}`);
                }
            } else {
                addLog('Received unexpected message format (not string or Blob).');
            }
        };

        ws.onclose = (event) => {
            setIsConnected(false);
            addLog(`Disconnected from server. Code: ${event.code}, Reason: ${event.reason || 'No reason'}.`);
            if (event.code !== 1000 && currentTransferId) {
                addLog('Unexpected disconnect during active transfer. Resetting states.');
                resetTransferStates();
            } else if (event.code === 1000 && currentTransferId) {
                addLog('Clean disconnect but active transfer. Resetting states.');
                resetTransferStates();
            } else {
                addLog('Disconnected. No active transfer to reset.');
            }
        };
        ws.onerror = (error) => {
            addLog(`WebSocket Error: ${error}`);
            console.error('WebSocket Error:', error);
            setIsConnected(false);
            if (currentTransferId) {
                addLog('WebSocket error during active transfer. Resetting states.');
                resetTransferStates();
            }
        };

        return () => {
            addLog('Component unmounting. Closing WebSocket connection if open.');
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.close(1000, "Component unmount");
            }
        };
    }, [addLog, role, transferCode, currentTransferId, fileToSend, receivedManifest, resetTransferStates]);


    // --- File Input and Manifest Generation ---
    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        if (event.target.files && event.target.files[0]) {
            setFileToSend(event.target.files[0]);
            addLog(`Selected file: ${event.target.files[0].name} (${(event.target.files[0].size / (1024 * 1024)).toFixed(2)} MB)`);
        }
    };

    const generateFileManifest = async (file: File): Promise<FileManifest> => {
        addLog('Generating file manifest...');
        const chunks: ChunkManifest[] = [];
        let offset = 0;
        let chunkIndex = 0;

        while (offset < file.size) {
            const chunk = file.slice(offset, offset + CHUNK_SIZE);
            const arrayBuffer = await chunk.arrayBuffer();
            const wordArray = CryptoJS.lib.WordArray.create(arrayBuffer);
            const md5Hash = CryptoJS.MD5(wordArray).toString();

            chunks.push({
                index: chunkIndex,
                size: chunk.size,
                md5Hash: md5Hash,
            });
            offset += chunk.size;
            chunkIndex++;
        }
        addLog(`Generated manifest for ${chunks.length} chunks. Total file size: ${file.size} bytes.`);
        return {
            fileName: file.name,
            fileSize: file.size,
            totalChunks: chunks.length,
            chunks: chunks,
        };
    };

    // --- Sender Actions ---
    const handleInitiateTransfer = async () => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            addLog('Error: WebSocket not connected. Cannot initiate transfer.');
            return;
        }
        if (!fileToSend) {
            addLog('Error: Please select a file to send before initiating.');
            return;
        }
        if (!transferCode.trim()) {
            addLog('Error: Please enter a transfer code before initiating.');
            return;
        }
        if (currentTransferId && currentTransferId !== transferCode) {
             addLog(`Error: Another transfer (${currentTransferId}) is active. Please wait or refresh to start a new one with a different code.`);
             return;
        }


        const manifest = await generateFileManifest(fileToSend);
        fileManifestRef.current = manifest;

        addLog(`Initiating transfer of "${manifest.fileName}" (${manifest.fileSize} bytes) using code "${transferCode}"...`);
        wsRef.current.send(JSON.stringify({
            type: 'initiate-transfer',
            payload: {
                transferCode: transferCode,
                manifest: manifest
            }
        }));
    };

    const sendChunk = async (file: File, manifest: FileManifest, transferId: string, chunkIndex: number) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            addLog(`Error: WebSocket not open to send chunk ${chunkIndex}. Retrying or connection lost.`);
            return;
        }

        const chunkInfo = manifest.chunks[chunkIndex];
        if (!chunkInfo) {
            addLog(`Error: Chunk info for index ${chunkIndex} not found in manifest. Cannot send.`);
            return;
        }

        const offset = chunkIndex * CHUNK_SIZE;
        const chunkBlob = file.slice(offset, offset + chunkInfo.size);

        wsRef.current.send(JSON.stringify({
            type: 'chunk-metadata',
            payload: {
                transferCode: transferId,
                chunkIndex: chunkIndex,
                originalMd5: chunkInfo.md5Hash
            }
        }));

        wsRef.current.send(chunkBlob);

        totalBytesSent.current += chunkBlob.size;
        chunkSentTime.current.set(chunkIndex, Date.now());

        const sentCount = chunkSentTime.current.size;
        setTransferProgress((sentCount / manifest.totalChunks) * 100);

        if (transferStartTime.current) {
            const duration = (Date.now() - transferStartTime.current) / 1000;
            if (duration > 0) {
                const speedMBps = (totalBytesSent.current / (1024 * 1024)) / duration;
                setTransferSpeed(`${speedMBps.toFixed(2)} MB/s`);
            }
        }
        addLog(`Sender: Sent chunk ${chunkIndex + 1}/${manifest.totalChunks}. Progress: ${((sentCount / manifest.totalChunks) * 100).toFixed(2)}%`);
    };

    const sendAllChunks = async (file: File, manifest: FileManifest, transferId: string) => {
        addLog('Starting parallel chunk transmission...');
        const CHUNKS_IN_FLIGHT_LIMIT = 5;

        const sendQueue: number[] = Array.from({ length: manifest.totalChunks }, (_, i) => i);
        let activeSends = 0;

        const processQueue = async () => {
            while (sendQueue.length > 0 && activeSends < CHUNKS_IN_FLIGHT_LIMIT) {
                const chunkIndex = sendQueue.shift();
                if (chunkIndex !== undefined) {
                    activeSends++;
                    try {
                        await sendChunk(file, manifest, transferId, chunkIndex);
                    } catch (error) {
                        addLog(`Failed to send chunk ${chunkIndex}: ${error}`);
                    } finally {
                        activeSends--;
                        if (wsRef.current?.readyState === WebSocket.OPEN) {
                            processQueue();
                        }
                    }
                }
            }
            if (sendQueue.length === 0 && activeSends === 0) {
                addLog('All chunks initially sent from sender. Signalling completion to server.');
                wsRef.current?.send(JSON.stringify({
                    type: 'transfer-complete-sender',
                    payload: { transferId: transferId }
                }));
            }
        };

        await processQueue();
    };


    // --- Receiver Actions ---
    const handleJoinTransfer = () => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            addLog('Error: WebSocket not connected. Cannot join transfer.');
            return;
        }
        if (!transferCode.trim()) {
            addLog('Error: Please enter a transfer code to join.');
            return;
        }
        if (currentTransferId && currentTransferId !== transferCode) {
            addLog(`Error: Already in an active transfer (${currentTransferId}). Please wait or refresh to join another with a different code.`);
            return;
        }
        if (currentTransferId === transferCode) {
            addLog(`Already joined transfer code ${transferCode}. Waiting for sender.`);
            return;
        }

        addLog(`Attempting to join transfer with code: ${transferCode}`);
        setCurrentTransferId(transferCode);
        wsRef.current.send(JSON.stringify({ type: 'join-transfer', payload: { transferCode: transferCode } }));
    };

    // --- Render UI ---
    return (
        <div className="App">
            <h1>WebSocket File Transfer</h1>

            <div className="role-selection">
                <label>
                    <input
                        type="radio"
                        name="role"
                        checked={role === 'sender'}
                        onChange={() => {
                            setRole('sender');
                            if (currentTransferId) {
                                addLog('Role changed to sender. Current transfer states reset.');
                                resetTransferStates();
                            }
                        }}
                        disabled={currentTransferId !== null && role === 'receiver'}
                    />
                    I am Sender (Client A)
                </label>
                <label>
                    <input
                        type="radio"
                        name="role"
                        checked={role === 'receiver'}
                        onChange={() => {
                            setRole('receiver');
                            if (currentTransferId) {
                                addLog('Role changed to receiver. Current transfer states reset.');
                                resetTransferStates();
                            }
                        }}
                        disabled={currentTransferId !== null && role === 'sender'}
                    />
                    I am Receiver (Client B)
                </label>
            </div>

            <div className="connection-info">
                <h2>Connection Info</h2>
                <p>My Peer ID: <strong>{myId || 'Connecting...'}</strong></p>
                <p>Connection Status: <strong>{isConnected ? 'Connected' : 'Disconnected'}</strong></p>
                <div>
                    Transfer Code:
                    <input
                        type="text"
                        value={transferCode}
                        onChange={(e) => setTransferCode(e.target.value)}
                        placeholder="Enter a shared transfer code (e.g., 'my-secret-room')"
                        disabled={currentTransferId !== null}
                    />
                    {role === 'receiver' && (
                        <button
                            onClick={handleJoinTransfer}
                            disabled={!transferCode.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || currentTransferId !== null}
                            style={{ marginLeft: '10px' }}
                        >
                            Join Transfer Code
                        </button>
                    )}
                </div>
            </div>

            {role === 'sender' && (
                <div className="sender-controls">
                    <h2>Sender (Client A)</h2>
                    <input type="file" onChange={handleFileChange} disabled={currentTransferId !== null} />
                    <button
                        onClick={handleInitiateTransfer}
                        disabled={!fileToSend || !transferCode.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || (currentTransferId !== null && currentTransferId !== transferCode)}
                    >
                        Initiate File Transfer
                    </button>
                    {currentTransferId && (
                        <>
                            <p>Transfer in progress: <strong>{currentTransferId}</strong></p>
                            <div className="progress-bar-container">
                                <div className="progress-bar" style={{ width: `${transferProgress}%` }}>
                                    {transferProgress.toFixed(2)}%
                                </div>
                            </div>
                            {transferSpeed && <p>Speed: {transferSpeed}</p>}
                            <p>Bytes Sent: {(totalBytesSent.current / (1024 * 1024)).toFixed(2)} MB / {((fileManifestRef.current?.fileSize || 0) / (1024 * 1024)).toFixed(2)} MB</p>
                        </>
                    )}
                </div>
            )}

            {role === 'receiver' && (
                <div className="receiver-status">
                    <h2>Receiver (Client B)</h2>
                    {currentTransferId ? (
                        <>
                            <p>Receiving file: <strong>{receivedManifest?.fileName || 'N/A'}</strong></p>
                            <p>Transfer ID: {currentTransferId}</p>
                            <div className="progress-bar-container">
                                <div className="progress-bar" style={{ width: `${transferProgress}%` }}>
                                    {transferProgress.toFixed(2)}%
                                </div>
                            </div>
                            <p>Received Chunks: {receivedChunksMap.size} / {receivedManifest?.totalChunks || 0}</p>
                            {transferSpeed && <p>Speed: {transferSpeed}</p>}
                            {showDownloadPrompt && receivedManifest && receivedChunksMap.size === receivedManifest.totalChunks && (
                                <button
                                    onClick={reassembleFile} // Call reassembleFile on button click
                                    style={{ marginTop: '10px' }}
                                >
                                    Download File
                                </button>
                            )}
                        </>
                    ) : (
                        <p>Waiting for incoming transfer, or enter code and click "Join Transfer Code".</p>
                    )}
                </div>
            )}

            <div className="logs">
                <h2>Logs</h2>
                <div className="log-output">
                    {log.map((entry, index) => (
                        <p key={index}>{entry}</p>
                    ))}
                </div>
                <button onClick={() => setLog([])} style={{ marginTop: '10px' }}>Clear Logs</button>
            </div>
        </div>
    );
};

export default App;
