'use strict';

// Single-row table (id = 1) holding the commercial rules. Edited from the admin dashboard.
module.exports = (sequelize, DataTypes) => {
  const PricingSetting = sequelize.define('PricingSetting', {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    tiers: { type: DataTypes.JSONB, allowNull: false },
    minHours: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2 },
    serviceFeeRate: { type: DataTypes.DECIMAL(5, 4), allowNull: false, defaultValue: 0.08 },
    quoteFeeRate: { type: DataTypes.DECIMAL(5, 4), allowNull: false, defaultValue: 0.1 },
    chefPayoutShare: { type: DataTypes.DECIMAL(5, 4), allowNull: false, defaultValue: 0.8 },
    idRequiredAbove: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 100000 },
    maxRecurringSessions: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 12 },
    quoteSlaHours: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2 },
    quoteValidityHours: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 24 },
    updatedByAdminId: { type: DataTypes.UUID, allowNull: true, references: { model: 'Admins', key: 'id' } },
  }, { tableName: 'PricingSettings', timestamps: true });

  return PricingSetting;
};
