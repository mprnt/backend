declare module 'qrcode' {
  const QRCode: {
    toString(text: string, options: Record<string, unknown>): Promise<string>;
    toFile(file: string, text: string, options: Record<string, unknown>): Promise<void>;
  };

  export = QRCode;
}
