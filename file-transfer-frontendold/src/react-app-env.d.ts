/// <reference types="react-scripts" />

declare module 'crypto-js'; // To allow importing crypto-js

interface Window {
  showSaveFilePicker?: (options?: any) => Promise<FileSystemFileHandle>;
}

interface FileSystemFileHandle {
  createWritable: () => Promise<FileSystemWritableFileStream>;
}

interface FileSystemWritableFileStream extends WritableStream<Blob | ArrayBuffer> {
  // Add any specific methods or properties you use from FileSystemWritableFileStream
  write(data: BufferSource | Blob | string | object): Promise<void>;
  close(): Promise<void>;
  seek?(position: number): Promise<void>;
  truncate?(size: number): Promise<void>;
}