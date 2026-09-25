import swaggerJsdoc from 'swagger-jsdoc';
import { Application } from 'express';
import swaggerUi from 'swagger-ui-express';

const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'MPrnt Backend API',
      version: '1.0.0',
      description: `
        MPrnt is a cloud-based print management system for kiosks.

        ## Features
        - Session management for print workflows
        - Document upload and processing
        - Print job creation with pricing calculation
        - Payment integration (Mock/Razorpay)
        - Print queue management

        ## Authentication
        Currently no authentication required (development phase)

        ## Rate Limiting
        - Global: 100 requests per 15 minutes per IP
        - Session creation: 10 requests per 15 minutes per IP

        ## Base URL
        \`http://localhost:3000/api/v1\`
      `,
      contact: {
        name: 'MPrnt API Support',
        email: 'support@mprnt.com',
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    servers: [
      {
        url: 'http://localhost:3000/api/v1',
        description: 'Development server',
      },
      {
        url: 'https://api.mprnt.com/api/v1',
        description: 'Production server',
      },
    ],
    tags: [
      {
        name: 'Sessions',
        description: 'Print session management endpoints',
      },
      {
        name: 'Documents',
        description: 'Document upload and management',
      },
      {
        name: 'Print Jobs',
        description: 'Print job creation and pricing',
      },
      {
        name: 'Payment',
        description: 'Payment processing (Mock/Razorpay)',
      },
      {
        name: 'Health',
        description: 'System health check',
      },
    ],
    components: {
      schemas: {
        Error: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              example: 'error',
            },
            message: {
              type: 'string',
              example: 'An error occurred',
            },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
        Session: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              example: 'S1727235636304',
            },
            kioskId: {
              type: 'string',
              format: 'uuid',
              example: '550e8400-e29b-41d4-a716-446655440000',
            },
            status: {
              type: 'string',
              enum: ['active', 'complete', 'expired', 'error'],
              example: 'active',
            },
            expiresAt: {
              type: 'string',
              format: 'date-time',
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        Document: {
          type: 'object',
          properties: {
            documentId: {
              type: 'string',
              format: 'uuid',
            },
            fileName: {
              type: 'string',
              example: 'document.pdf',
            },
            fileSize: {
              type: 'integer',
              example: 1024000,
            },
            mimeType: {
              type: 'string',
              example: 'application/pdf',
            },
            pageCount: {
              type: 'integer',
              example: 10,
            },
            processed: {
              type: 'boolean',
              example: true,
            },
            uploadedAt: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        PrintSettings: {
          type: 'object',
          required: ['colorMode'],
          properties: {
            colorMode: {
              type: 'string',
              enum: ['bw', 'color'],
              example: 'bw',
            },
            copies: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 1,
              example: 1,
            },
            pageRange: {
              type: 'string',
              enum: ['all', 'custom'],
              default: 'all',
              example: 'all',
            },
            customRange: {
              type: 'string',
              example: '1-5,8,10-12',
              description: 'Required when pageRange is "custom"',
            },
            printSides: {
              type: 'string',
              enum: ['single', 'double'],
              default: 'single',
              example: 'single',
            },
            paperSize: {
              type: 'string',
              enum: ['a4', 'letter'],
              default: 'a4',
              example: 'a4',
            },
            orientation: {
              type: 'string',
              enum: ['portrait', 'landscape'],
              default: 'portrait',
              example: 'portrait',
            },
          },
        },
        PrintJob: {
          type: 'object',
          properties: {
            jobId: {
              type: 'string',
              format: 'uuid',
            },
            sessionId: {
              type: 'string',
            },
            documentId: {
              type: 'string',
              format: 'uuid',
            },
            settings: {
              $ref: '#/components/schemas/PrintSettings',
            },
            pricing: {
              type: 'object',
              properties: {
                pricePerPage: {
                  type: 'number',
                  example: 2.0,
                },
                logicalPages: {
                  type: 'integer',
                  example: 10,
                },
                physicalPages: {
                  type: 'integer',
                  example: 5,
                },
                totalPages: {
                  type: 'integer',
                  example: 10,
                },
                totalAmount: {
                  type: 'number',
                  example: 20.0,
                },
              },
            },
            status: {
              type: 'string',
              enum: ['pending', 'queued', 'printing', 'completed', 'failed', 'cancelled'],
              example: 'pending',
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        PaymentOrder: {
          type: 'object',
          properties: {
            orderId: {
              type: 'string',
              example: 'order_mock_1727235636304_abc123',
            },
            amount: {
              type: 'number',
              example: 20.0,
            },
            currency: {
              type: 'string',
              example: 'INR',
            },
            status: {
              type: 'string',
              enum: ['created', 'pending', 'authorized', 'captured', 'failed', 'refunded'],
              example: 'created',
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
      },
    },
  },
  apis: ['./src/routes/*.ts', './src/app.ts'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

export const setupSwagger = (app: Application): void => {
  // Swagger UI
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'MPrnt API Documentation',
  }));

  // Swagger JSON
  app.get('/api-docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
};

export default swaggerSpec;
