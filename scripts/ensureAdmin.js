require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../models');

const { Admin } = db;

// Set DEFAULT_ADMIN_EMAIL / DEFAULT_ADMIN_PASSWORD to choose them. Without a password, a random one is
// generated and printed once (there is no built-in default password).
const DEFAULT_EMAIL = process.env.DEFAULT_ADMIN_EMAIL || 'admin@homie.app';
const GENERATED = !process.env.DEFAULT_ADMIN_PASSWORD;
const DEFAULT_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || `Hm-${crypto.randomBytes(9).toString('base64url')}`;

const permissions = {
  users: { read: true, write: true, delete: true },
  billing: { read: true, write: true, refund: true },
  infrastructure: { read: true, write: true },
  settings: { read: true, write: true },
  audit: { read: true },
  reports: { read: true, export: true },
};

const ensureAdmin = async () => {
  try {
    await db.sequelize.authenticate();
    await Admin.sync();

    const password = await bcrypt.hash(DEFAULT_PASSWORD, 12);
    const [admin, created] = await Admin.findOrCreate({
      where: { email: DEFAULT_EMAIL.toLowerCase() },
      defaults: {
        email: DEFAULT_EMAIL.toLowerCase(),
        password,
        firstName: 'Homie',
        lastName: 'Admin',
        role: 'super_admin',
        permissions,
        status: 'active',
      },
    });

    if (!created) {
      await admin.update({
        password,
        firstName: admin.firstName || 'Homie',
        lastName: admin.lastName || 'Admin',
        role: 'super_admin',
        permissions,
        status: 'active',
      });
    }

    console.log('Default admin ready');
    console.log(`Email: ${DEFAULT_EMAIL}`);
    console.log(GENERATED ? `Password: ${DEFAULT_PASSWORD}   (generated - save it now, it is not stored anywhere)` : 'Password: the value of DEFAULT_ADMIN_PASSWORD');
  } catch (error) {
    console.error('Failed to ensure default admin:', error);
    process.exitCode = 1;
  } finally {
    await db.sequelize.close();
  }
};

ensureAdmin();
