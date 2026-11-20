require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const http = require('http');
const db = require('./models');
const homieSocket = require('./socket/homie');
const bookingService = require('./services/booking.service');

const appRoutes = require('./routes/app');
const homieAdminRoutes = require('./routes/homieAdmin.routes');
const authRoutes = require('./routes/auth.routes');
const adminAuthRoutes = require('./routes/adminAuth.routes');
const adminBillingRoutes = require('./routes/adminBilling.routes');
const billingRoutes = require('./routes/billing.routes');
const profileRoutes = require('./routes/profile.routes');

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    return callback(null, origin || true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: {
    success: false,
    message: 'Too many requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // The mobile app has its own, higher limit below (chat and booking updates are chatty).
  skip: (req) => req.path.startsWith('/api/app'),
}));

app.use('/api/app', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: {
    success: false,
    message: 'Too many requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
}));

// rawBody is kept so the Paystack webhook signature can be verified.
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(morgan(process.env.NODE_ENV === 'development' ? 'dev' : 'combined'));

app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Homie API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

app.use('/api/app', appRoutes);
app.use('/api/admin-homie', homieAdminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin-auth', adminAuthRoutes);
app.use('/api/admin-billing', adminBillingRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/profile', profileRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
  });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);

  if (err.name === 'SequelizeValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: err.errors.map((error) => ({
        field: error.path,
        message: error.message,
      })),
    });
  }

  if (err.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({
      success: false,
      message: 'Resource already exists',
      errors: err.errors.map((error) => ({
        field: error.path,
        message: error.message,
      })),
    });
  }

  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: 'Invalid token',
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      message: 'Token expired',
    });
  }

  return res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
  });
});

const PORT = process.env.API_PORT || 8082;

const startServer = async () => {
  try {
    await db.sequelize.authenticate();
    console.log('Database connection established successfully');

    if (process.env.NODE_ENV === 'development' && process.env.DB_SYNC === 'true') {
      await db.sequelize.sync({ alter: true });
      console.log('Database models synced');
    }

    const server = http.createServer(app);
    homieSocket.init(server);

    server.listen(PORT, () => {
      console.log(`
========================================
            HOMIE API SERVER
========================================
    Port: ${PORT}
    Environment: ${process.env.NODE_ENV || 'development'}
    API Base: http://localhost:${PORT}/api
========================================
      `);
    });

    // Auto-release escrow, expire unpaid bookings, time out silent chefs, retry payouts.
    if (process.env.HOMIE_JOBS !== 'off') {
      const run = () => require('./services/bookingFlows.service').runScheduledJobs().then((s) => {
        if (Object.values(s).some(Boolean)) console.log('Scheduled jobs:', s);
      });
      setTimeout(run, 15 * 1000);
      setInterval(run, 5 * 60 * 1000);
    }
  } catch (error) {
    console.error('Unable to start server:', error);
    process.exit(1);
  }
};

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  await db.sequelize.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Shutting down gracefully...');
  await db.sequelize.close();
  process.exit(0);
});

startServer();

module.exports = { app };
