'use strict';

// Business model restructure: chef tiers + admin-editable pricing, KYC records, Chef + Ingredients quotes,
// recurring series, "Match me" allocation, and procurement tracking.
// See docs/superpowers/specs/2026-11-20-business-model-restructure-design.md

const uuid = (Sequelize) => ({ type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false });
const fk = (Sequelize, model, { allowNull = false, onDelete = 'CASCADE' } = {}) => ({
  type: Sequelize.UUID, allowNull, references: { model, key: 'id' }, onUpdate: 'CASCADE', onDelete,
});
const stamps = (Sequelize) => ({
  createdAt: { type: Sequelize.DATE, allowNull: false },
  updatedAt: { type: Sequelize.DATE, allowNull: false },
});

const TIERS = ['standard', 'premium', 'elite'];
const KYC = ['registered', 'pending', 'verified', 'approved', 'suspended', 'rejected'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    // ---- enum values (each statement auto-commits so later UPDATEs can use them)
    await q(`ALTER TYPE "enum_Bookings_status" ADD VALUE IF NOT EXISTS 'scheduled'`);
    await q(`ALTER TYPE "enum_Bookings_status" ADD VALUE IF NOT EXISTS 'pending_allocation'`);
    for (const value of ['registered', 'approved', 'suspended']) {
      await q(`ALTER TYPE "enum_ChefProfiles_verificationStatus" ADD VALUE IF NOT EXISTS '${value}'`);
    }

    // ---- Pricing settings (single row, editable from the admin dashboard)
    await queryInterface.createTable('PricingSettings', {
      id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false },
      tiers: { type: Sequelize.JSONB, allowNull: false },
      minHours: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 2 },
      serviceFeeRate: { type: Sequelize.DECIMAL(5, 4), allowNull: false, defaultValue: 0.08 },
      quoteFeeRate: { type: Sequelize.DECIMAL(5, 4), allowNull: false, defaultValue: 0.1 },
      chefPayoutShare: { type: Sequelize.DECIMAL(5, 4), allowNull: false, defaultValue: 0.8 },
      idRequiredAbove: { type: Sequelize.DECIMAL(15, 2), allowNull: false, defaultValue: 100000 },
      maxRecurringSessions: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 12 },
      quoteSlaHours: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 2 },
      quoteValidityHours: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 24 },
      updatedByAdminId: fk(Sequelize, 'Admins', { allowNull: true, onDelete: 'SET NULL' }),
      ...stamps(Sequelize),
    });
    const now = new Date();
    await queryInterface.bulkInsert('PricingSettings', [{
      id: 1,
      tiers: JSON.stringify({
        standard: { customerRate: 12500, chefPayout: 10000 },
        premium: { customerRate: 17500, chefPayout: 14000 },
        elite: { customerRate: 25000, chefPayout: 20000 },
      }),
      minHours: 2, serviceFeeRate: 0.08, quoteFeeRate: 0.1, chefPayoutShare: 0.8, idRequiredAbove: 100000,
      maxRecurringSessions: 12, quoteSlaHours: 2, quoteValidityHours: 24, createdAt: now, updatedAt: now,
    }]);

    // ---- Chef profiles: tier + new KYC status vocabulary
    await queryInterface.addColumn('ChefProfiles', 'tier', { type: Sequelize.ENUM(...TIERS), allowNull: false, defaultValue: 'standard' });
    await q(`ALTER TABLE "ChefProfiles" ALTER COLUMN "verificationStatus" SET DEFAULT 'registered'`);
    await q(`UPDATE "ChefProfiles" SET "verificationStatus" = 'approved' WHERE "verificationStatus" = 'verified'`);
    await q(`UPDATE "ChefProfiles" SET "verificationStatus" = 'registered' WHERE "verificationStatus" = 'unsubmitted'`);
    await q(`UPDATE "ChefProfiles" SET "startingPrice" = 12500, "startingUnit" = 'hour'`);

    await queryInterface.createTable('ChefKycs', {
      id: uuid(Sequelize),
      chefId: { ...fk(Sequelize, 'ChefProfiles'), unique: true },
      dateOfBirth: { type: Sequelize.DATEONLY, allowNull: true },
      residentialAddress: { type: Sequelize.TEXT, allowNull: true },
      idType: { type: Sequelize.STRING(30), allowNull: true },
      idLast4: { type: Sequelize.STRING(4), allowNull: true },
      documents: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      references: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      backgroundCheck: { type: Sequelize.JSONB, allowNull: false, defaultValue: { status: 'not_started' } },
      practicalAssessment: { type: Sequelize.JSONB, allowNull: false, defaultValue: { status: 'not_started' } },
      agreement: { type: Sequelize.JSONB, allowNull: true },
      checklist: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      submittedAt: { type: Sequelize.DATE, allowNull: true },
      reviewedAt: { type: Sequelize.DATE, allowNull: true },
      reviewNote: { type: Sequelize.TEXT, allowNull: true },
      ...stamps(Sequelize),
    });

    // ---- Customers (members): KYC
    await queryInterface.addColumn('Members', 'dateOfBirth', { type: Sequelize.DATEONLY, allowNull: true });
    await queryInterface.addColumn('Members', 'emailVerifiedAt', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn('Members', 'kycStatus', { type: Sequelize.ENUM(...KYC), allowNull: false, defaultValue: 'registered' });
    await queryInterface.addColumn('Members', 'idType', { type: Sequelize.STRING(30), allowNull: true });
    await queryInterface.addColumn('Members', 'idLast4', { type: Sequelize.STRING(4), allowNull: true });
    await queryInterface.addColumn('Members', 'idDocumentRef', { type: Sequelize.STRING(300), allowNull: true });
    await queryInterface.addColumn('Members', 'idSubmittedAt', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn('Members', 'idVerifiedAt', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn('Members', 'kycNote', { type: Sequelize.TEXT, allowNull: true });
    // Existing members were onboarded before KYC existed: treat them as cleared.
    await q(`UPDATE "Members" SET "kycStatus" = 'approved'`);
    await q(`UPDATE "Members" SET "emailVerifiedAt" = now() WHERE email IS NOT NULL`);

    // ---- Quotes (Chef + Ingredients)
    await queryInterface.createTable('Quotes', {
      id: uuid(Sequelize),
      reference: { type: Sequelize.STRING(20), allowNull: false, unique: true },
      customerId: fk(Sequelize, 'Members', { onDelete: 'RESTRICT' }),
      preferredChefId: fk(Sequelize, 'ChefProfiles', { allowNull: true, onDelete: 'SET NULL' }),
      matchRequested: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      tier: { type: Sequelize.ENUM(...TIERS), allowNull: false, defaultValue: 'standard' },
      cuisine: { type: Sequelize.STRING(60), allowNull: true },
      menuText: { type: Sequelize.TEXT, allowNull: false },
      dishes: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      guests: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      scheduledAt: { type: Sequelize.DATE, allowNull: false },
      address: { type: Sequelize.TEXT, allowNull: false },
      dietary: { type: Sequelize.TEXT, allowNull: true },
      status: { type: Sequelize.ENUM('requested', 'quoted', 'approved', 'declined', 'expired', 'cancelled'), allowNull: false, defaultValue: 'requested' },
      respondBy: { type: Sequelize.DATE, allowNull: true },
      quotedAt: { type: Sequelize.DATE, allowNull: true },
      validUntil: { type: Sequelize.DATE, allowNull: true },
      lineItems: { type: Sequelize.JSONB, allowNull: true },
      ingredientsAmount: { type: Sequelize.DECIMAL(15, 2), allowNull: true },
      chefFee: { type: Sequelize.DECIMAL(15, 2), allowNull: true },
      logisticsAmount: { type: Sequelize.DECIMAL(15, 2), allowNull: true },
      platformFee: { type: Sequelize.DECIMAL(15, 2), allowNull: true },
      total: { type: Sequelize.DECIMAL(15, 2), allowNull: true },
      chefPayout: { type: Sequelize.DECIMAL(15, 2), allowNull: true },
      adminNote: { type: Sequelize.TEXT, allowNull: true },
      quotedByAdminId: fk(Sequelize, 'Admins', { allowNull: true, onDelete: 'SET NULL' }),
      approvedAt: { type: Sequelize.DATE, allowNull: true },
      bookingId: { type: Sequelize.UUID, allowNull: true },
      declineReason: { type: Sequelize.TEXT, allowNull: true },
      ...stamps(Sequelize),
    });
    await queryInterface.addIndex('Quotes', ['customerId']);
    await queryInterface.addIndex('Quotes', ['status']);

    // ---- Bookings
    await q(`ALTER TABLE "Bookings" ALTER COLUMN "chefId" DROP NOT NULL`);
    await queryInterface.addColumn('Bookings', 'serviceLine', { type: Sequelize.ENUM('chef_time', 'chef_ingredients'), allowNull: false, defaultValue: 'chef_time' });
    await queryInterface.addColumn('Bookings', 'tier', { type: Sequelize.ENUM(...TIERS), allowNull: false, defaultValue: 'standard' });
    await queryInterface.addColumn('Bookings', 'serviceFee', { type: Sequelize.DECIMAL(15, 2), allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('Bookings', 'ingredientsAmount', { type: Sequelize.DECIMAL(15, 2), allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('Bookings', 'logisticsAmount', { type: Sequelize.DECIMAL(15, 2), allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('Bookings', 'platformFee', { type: Sequelize.DECIMAL(15, 2), allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('Bookings', 'lineItems', { type: Sequelize.JSONB, allowNull: true });
    await queryInterface.addColumn('Bookings', 'recurrence', { type: Sequelize.ENUM('once', 'weekly', 'monthly'), allowNull: false, defaultValue: 'once' });
    await queryInterface.addColumn('Bookings', 'seriesId', { type: Sequelize.UUID, allowNull: true });
    await queryInterface.addColumn('Bookings', 'seriesIndex', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 });
    await queryInterface.addColumn('Bookings', 'seriesTotal', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 });
    await queryInterface.addColumn('Bookings', 'preAccepted', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn('Bookings', 'matchRequested', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn('Bookings', 'cuisine', { type: Sequelize.STRING(60), allowNull: true });
    await queryInterface.addColumn('Bookings', 'allocatedAt', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn('Bookings', 'allocatedByAdminId', fk(Sequelize, 'Admins', { allowNull: true, onDelete: 'SET NULL' }));
    await queryInterface.addColumn('Bookings', 'payByAt', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn('Bookings', 'quoteId', { type: Sequelize.UUID, allowNull: true });
    await queryInterface.addColumn('Bookings', 'procurementStatus', {
      type: Sequelize.ENUM('not_required', 'pending', 'purchasing', 'purchased', 'delivered'), allowNull: false, defaultValue: 'not_required',
    });
    await queryInterface.addColumn('Bookings', 'procurementNotes', { type: Sequelize.TEXT, allowNull: true });
    await queryInterface.addColumn('Bookings', 'ingredientsActualCost', { type: Sequelize.DECIMAL(15, 2), allowNull: true });
    await queryInterface.addColumn('Bookings', 'procurementReceipts', { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });
    await queryInterface.addIndex('Bookings', ['seriesId']);
    await queryInterface.addIndex('Bookings', ['quoteId']);
    // Existing bookings were priced hourly-less; keep them as they are (chef_time / standard defaults).
  },

  async down(queryInterface) {
    const cols = [
      'procurementReceipts', 'ingredientsActualCost', 'procurementNotes', 'procurementStatus', 'quoteId', 'payByAt', 'allocatedByAdminId',
      'allocatedAt', 'cuisine', 'matchRequested', 'preAccepted', 'seriesTotal', 'seriesIndex', 'seriesId', 'recurrence', 'lineItems',
      'platformFee', 'logisticsAmount', 'ingredientsAmount', 'serviceFee', 'tier', 'serviceLine',
    ];
    for (const c of cols) await queryInterface.removeColumn('Bookings', c);
    await queryInterface.dropTable('Quotes');
    for (const c of ['kycNote', 'idVerifiedAt', 'idSubmittedAt', 'idDocumentRef', 'idLast4', 'idType', 'kycStatus', 'emailVerifiedAt', 'dateOfBirth']) {
      await queryInterface.removeColumn('Members', c);
    }
    await queryInterface.dropTable('ChefKycs');
    await queryInterface.removeColumn('ChefProfiles', 'tier');
    await queryInterface.dropTable('PricingSettings');
    for (const type of ['enum_Quotes_status', 'enum_Quotes_tier', 'enum_Bookings_serviceLine', 'enum_Bookings_tier', 'enum_Bookings_recurrence',
      'enum_Bookings_procurementStatus', 'enum_Members_kycStatus', 'enum_ChefProfiles_tier']) {
      await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "${type}";`);
    }
    // Note: values added to enum_Bookings_status / enum_ChefProfiles_verificationStatus cannot be removed in PostgreSQL.
  },
};
