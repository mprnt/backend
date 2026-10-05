# MPrnt Backend

Backend API for the MPrnt kiosk printing system - handling QR-based printing workflow, Raspberry Pi printer integration, payment processing, and admin dashboard.

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 16+
- npm 10+

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy environment file:
   ```bash
   cp .env.example .env
   ```

4. Configure your `.env` file with appropriate values

5. Run in development mode:
   ```bash
   npm run dev
   ```

## 📁 Project Structure

```
src/
├── config/          # Configuration files
├── controllers/     # Request handlers
├── middleware/      # Express middleware
├── models/          # Database models
├── routes/          # API routes
├── services/        # Business logic
├── types/           # TypeScript type definitions
├── utils/           # Utility functions
├── app.ts           # Express app setup
└── index.ts         # Server entry point

tests/               # Test files
scripts/             # Utility scripts
```

## 🛠️ Available Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm test` - Run tests
- `npm run lint` - Lint code
- `npm run format` - Format code with Prettier

## 🔧 Technology Stack

- **Runtime**: Node.js 20+ with TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL
- **Cache**: in-process (no Redis)
- **Background jobs**: in-process timers, coordinated with Postgres advisory locks
- **Storage**: AWS S3 / MinIO
- **Payment**: Razorpay
- **WebSocket**: ws
- **Logging**: Winston

## 📚 API Documentation

API documentation will be available at `/api/v1/docs` once implemented.

## 🏗️ Architecture

See [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md) for detailed architecture documentation.

## 🔐 Security

- JWT authentication for admin dashboard
- Rate limiting on all endpoints
- Helmet.js security headers
- CORS configuration
- Input validation with Joi
- Bcrypt password hashing

## 📝 Development Guide

See [DEVELOPMENT_GUIDE.md](DEVELOPMENT_GUIDE.md) for development guidelines and best practices.

## 🤝 Contributing

1. Create a feature branch
2. Make your changes
3. Run tests and linting
4. Submit a pull request

## 📄 License

MIT
