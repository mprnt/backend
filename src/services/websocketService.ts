import { WebSocketServer, WebSocket } from 'ws';
import { Server as HTTPServer } from 'http';
import logger from '../utils/logger';

interface ClientSubscription {
  jobId: string;
  ws: WebSocket;
}

export class WebSocketService {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ClientSubscription> = new Map();
  private subscriptions: Map<string, Set<string>> = new Map(); // jobId -> Set of client IDs

  initialize(httpServer: HTTPServer, path: string): void {
    this.wss = new WebSocketServer({ server: httpServer, path });

    this.wss.on('connection', (ws: WebSocket) => {
      const clientId = this.generateClientId();
      logger.info('WebSocket client connected', { clientId });

      ws.on('message', (message: string) => {
        try {
          const data = JSON.parse(message);
          this.handleMessage(clientId, ws, data);
        } catch (error) {
          logger.error('Invalid WebSocket message', { clientId, error });
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(clientId);
        logger.info('WebSocket client disconnected', { clientId });
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error', { clientId, error });
      });
    });

    logger.info('WebSocket server initialized', { path });
  }

  private handleMessage(clientId: string, ws: WebSocket, data: any): void {
    if (data.type === 'subscribe') {
      this.subscribe(clientId, ws, data.jobId);
    } else if (data.type === 'unsubscribe') {
      this.unsubscribe(clientId, data.jobId);
    }
  }

  private subscribe(clientId: string, ws: WebSocket, jobId: string): void {
    this.clients.set(clientId, { jobId, ws });

    if (!this.subscriptions.has(jobId)) {
      this.subscriptions.set(jobId, new Set());
    }
    this.subscriptions.get(jobId)!.add(clientId);

    ws.send(
      JSON.stringify({
        type: 'subscribed',
        jobId,
        message: `Subscribed to job ${jobId}`,
      })
    );

    logger.info('Client subscribed to job', { clientId, jobId });
  }

  private unsubscribe(clientId: string, jobId: string): void {
    const subscription = this.subscriptions.get(jobId);
    if (subscription) {
      subscription.delete(clientId);
      if (subscription.size === 0) {
        this.subscriptions.delete(jobId);
      }
    }
    this.clients.delete(clientId);

    logger.info('Client unsubscribed from job', { clientId, jobId });
  }

  private handleDisconnect(clientId: string): void {
    const subscription = this.clients.get(clientId);
    if (subscription) {
      this.unsubscribe(clientId, subscription.jobId);
    }
  }

  broadcastJobStatus(jobId: string, status: string, data?: any): void {
    const subscribers = this.subscriptions.get(jobId);

    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: 'job-status',
      jobId,
      status,
      data,
      timestamp: new Date().toISOString(),
    });

    subscribers.forEach((clientId) => {
      const client = this.clients.get(clientId);
      if (client && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    });

    logger.debug('Broadcasted job status', { jobId, status, subscribers: subscribers.size });
  }

  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  getStats(): { connectedClients: number; subscribedJobs: number } {
    return {
      connectedClients: this.clients.size,
      subscribedJobs: this.subscriptions.size,
    };
  }
}

export const websocketService = new WebSocketService();
