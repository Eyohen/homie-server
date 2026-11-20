'use strict';

module.exports = (sequelize, DataTypes) => {
  const Dispute = sequelize.define('Dispute', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    bookingId: { type: DataTypes.UUID, allowNull: false, references: { model: 'Bookings', key: 'id' } },
    openedById: { type: DataTypes.UUID, allowNull: false, references: { model: 'Members', key: 'id' } },
    reason: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.ENUM('open', 'under_review', 'resolved'), allowNull: false, defaultValue: 'open' },
    resolution: { type: DataTypes.ENUM('release', 'refund', 'split'), allowNull: true },
    splitPercentToChef: { type: DataTypes.INTEGER, allowNull: true },
    resolutionNote: { type: DataTypes.TEXT, allowNull: true },
    resolvedByAdminId: { type: DataTypes.UUID, allowNull: true, references: { model: 'Admins', key: 'id' } },
    resolvedAt: { type: DataTypes.DATE, allowNull: true },
    proposedResolution: { type: DataTypes.JSONB, allowNull: true },
    proposedByAdminId: { type: DataTypes.UUID, allowNull: true, references: { model: 'Admins', key: 'id' } },
    proposedAt: { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'Disputes', timestamps: true });

  Dispute.associate = (models) => {
    Dispute.belongsTo(models.Booking, { foreignKey: 'bookingId', as: 'booking' });
    Dispute.belongsTo(models.Member, { foreignKey: 'openedById', as: 'openedBy' });
  };

  return Dispute;
};
