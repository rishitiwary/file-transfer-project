import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = 8080;

// Type for transfer sessions
type FileTransfer = {
  fileName: string;
  fileSize: number;
  totalChunks: number;
  receivedChunks: Map<number, Buffer>;
  createdAt: number;
  tempDir?: string;
  completed?: boolean;
};

// In-memory storage for transfers
const transfers = new Map<string, FileTransfer>();

// Cleanup old transfers hourly
setInterval(() => cleanupOldTransfers(), 60 * 60 * 1000);

function cleanupOldTransfers() {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  transfers.forEach((transfer, transferId) => {
    if (now - transfer.createdAt > oneHour) {
      cleanupTransfer(transferId);
    }
  });
}

function cleanupTransfer(transferId: string) {
  const transfer = transfers.get(transferId);
  if (transfer?.tempDir) {
    try {
      fs.rmSync(transfer.tempDir, { recursive: true });
    } catch (err) {
      console.error(`Error cleaning up transfer ${transferId}:`, err);
    }
  }
  transfers.delete(transferId);
}

function validateFileName(fileName: string): boolean {
  return !/[\\/:*?"<>|]/.test(fileName) && fileName.length <= 255;
}

app.use(express.json());
app.use(cors());

// Initiate a new file transfer
app.post('/initiate-transfer', (req, res) => {
  const { fileName, fileSize, totalChunks } = req.body;
  
  if (!fileName || !fileSize || !totalChunks) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!validateFileName(fileName)) {
    return res.status(400).json({ error: 'Invalid file name' });
  }

  const transferId = crypto.randomBytes(8).toString('hex');
  const createdAt = Date.now();

  transfers.set(transferId, {
    fileName,
    fileSize,
    totalChunks,
    receivedChunks: new Map(),
    createdAt
  });

  console.log(`Transfer initiated: ${transferId}`);
  res.json({ transferId });
});

// Upload a file chunk
app.post('/upload-chunk/:transferId', upload.single('chunk'), (req, res) => {
  try {
    const { transferId } = req.params;
    const { chunkIndex } = req.body;
    const chunkData = req.file?.buffer;

    if (!chunkData) {
      return res.status(400).json({ error: 'No chunk data provided' });
    }

    const transfer = transfers.get(transferId);
    if (!transfer) {
      return res.status(404).json({ error: 'Transfer not found' });
    }

    const index = parseInt(chunkIndex);
    if (isNaN(index) || index < 0 || index >= transfer.totalChunks) {
      return res.status(400).json({ error: 'Invalid chunk index' });
    }

    transfer.receivedChunks.set(index, chunkData);
    console.log(`Chunk ${index} received for ${transferId}`);

    res.json({ success: true });
  } catch (err) {
    console.error('Chunk upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Finalize the transfer and assemble file
app.post('/finalize-transfer/:transferId', async (req, res) => {
  try {
    const { transferId } = req.params;
    const transfer = transfers.get(transferId);

    if (!transfer) {
      return res.status(404).json({ error: 'Transfer not found' });
    }

    if (transfer.receivedChunks.size !== transfer.totalChunks) {
      return res.status(400).json({ 
        error: `Incomplete transfer (${transfer.receivedChunks.size}/${transfer.totalChunks} chunks)`,
        missingChunks: Array.from(
          { length: transfer.totalChunks }, 
          (_, i) => i
        ).filter(i => !transfer.receivedChunks.has(i))
      });
    }

    // Create temp directory
    const tempDir = path.join(__dirname, 'temp', `transfer-${transferId}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Write all chunks to disk in order
    const outputPath = path.join(tempDir, transfer.fileName);
    const writeStream = fs.createWriteStream(outputPath);

    for (let i = 0; i < transfer.totalChunks; i++) {
      const chunk = transfer.receivedChunks.get(i);
      if (!chunk) {
        throw new Error(`Missing chunk ${i}`);
      }
      writeStream.write(chunk);
    }

    writeStream.end();

    // Update transfer with completion info
    transfer.completed = true;
    transfer.tempDir = tempDir;

    res.json({ 
      success: true,
      fileName: transfer.fileName,
      fileSize: transfer.fileSize
    });
  } catch (err) {
    console.error('Finalization error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all active transfers
app.get('/transfers', (req, res) => {
  const transfersList = Array.from(transfers.entries()).map(([id, t]) => ({
    transferId: id,
    fileName: t.fileName,
    fileSize: t.fileSize,
    progress: t.receivedChunks.size / t.totalChunks,
    completed: t.receivedChunks.size === t.totalChunks,
    createdAt: t.createdAt
  }));

  res.json(transfersList);
});

// Download completed file
app.get('/download/:transferId', (req, res) => {
  const { transferId } = req.params;
  const transfer = transfers.get(transferId);

  if (!transfer || !transfer.completed || !transfer.tempDir) {
    return res.status(404).json({ error: 'Transfer not found or not completed' });
  }

  const filePath = path.join(transfer.tempDir, transfer.fileName);
  res.download(filePath, transfer.fileName, (err) => {
    if (err) {
      console.error('Download failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed' });
      }
    }
  });
});

// Get transfer status
app.get('/transfer-status/:transferId', (req, res) => {
  const { transferId } = req.params;
  const transfer = transfers.get(transferId);

  if (!transfer) {
    return res.status(404).json({ error: 'Transfer not found' });
  }

  res.json({
    fileName: transfer.fileName,
    fileSize: transfer.fileSize,
    totalChunks: transfer.totalChunks,
    receivedChunks: transfer.receivedChunks.size,
    progress: (transfer.receivedChunks.size / transfer.totalChunks) * 100,
    completed: transfer.completed || false,
    createdAt: transfer.createdAt
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  
  // Ensure directories exist
  fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });
  fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
});