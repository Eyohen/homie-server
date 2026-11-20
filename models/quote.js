'use strict';

module.exports = (sequelize, DataTypes) => {
  const Quote = sequelize.define('Quote', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    reference: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    customerId: { type: DataTypes.UUID, allowNull: false, references: { model: 'Members', key: 'id' } },
    preferredChefId: { type: DataTypes.UUID, allowNull: true, references: { model: 'ChefProfiles', key: 'id' } },
    matchRequested: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    tier: { type: DataTypes.ENUM('standard', 'premium', 'elite'), allowNull: false, defaultValue: 'standard' },
    cuisine: { type: DataTypes.STRING(60), allowNull: true },
    menuText: { type: DataTypes.TEXT, allowNull: false },
    dishes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    guests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    scheduledAt: { type: DataTypes.DATE, allowNull: false },
    address: { type: DataTypes.TEXT, allowNull: false },
    dietary: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.ENUM('requested', 'quoted', 'approved', 'declined', 'expired', 'cancelled'), allowNull: false, defaultValue: 'requested' },
    respondBy: { type: DataTypes.DATE, allowNull: true },
    quotedAt: { type: DataTypes.DATE, allowNull: true },
    validUntil: { type: DataTypes.DATE, allowNull: true },
    lineItems: { type: DataTypes.JSONB, allowNull: true },
    ingredientsAmount: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    chefFee: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    logisticsAmount: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    platformFee: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    total: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    chefPayout: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    adminNote: { type: DataTypes.TEXT, allowNull: true },
    quotedByAdminId: { type: DataTypes.UUID, allowNull: true, references: { model: 'Admins', key: 'id' } },
    approvedAt: { type: DataTypes.DATE, allowNull: true },
    bookingId: { type: DataTypes.UUID, allowNull: true },
    declineReason: { type: DataTypes.TEXT, allowNull: true },
  }, { tableName: 'Quotes', timestamps: true });

  Quote.associate = (models) => {
    Quote.belongsTo(models.Member, { foreignKey: 'customerId', as: 'customer' });
    Quote.belongsTo(models.ChefProfile, { foreignKey: 'preferredChefId', as: 'preferredChef' });
  };

  return Quote;
};
