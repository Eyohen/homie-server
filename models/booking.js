'use strict';

const STATUSES = [
  'awaiting_payment', 'pending_chef', 'confirmed', 'in_progress', 'awaiting_approval',
  'completed', 'cancelled', 'declined', 'disputed', 'expired',
];

module.exports = (sequelize, DataTypes) => {
  const Booking = sequelize.define('Booking', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    reference: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    hirerId: { type: DataTypes.UUID, allowNull: false, references: { model: 'Members', key: 'id' } },
    chefId: { type: DataTypes.UUID, allowNull: false, references: { model: 'ChefProfiles', key: 'id' } },
    serviceId: { type: DataTypes.UUID, allowNull: true, references: { model: 'ChefServices', key: 'id' } },
    serviceTitle: { type: DataTypes.STRING(150), allowNull: false },
    serviceUnit: { type: DataTypes.STRING(20), allowNull: false },
    unitPrice: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    scheduledAt: { type: DataTypes.DATE, allowNull: false },
    guests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    address: { type: DataTypes.TEXT, allowNull: false },
    notes: { type: DataTypes.TEXT, allowNull: true },
    chefFee: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    groceries: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
    total: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    commissionRate: { type: DataTypes.DECIMAL(5, 4), allowNull: false },
    commission: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    chefPayout: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    status: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: 'awaiting_payment' },
    paidAt: { type: DataTypes.DATE, allowNull: true },
    acceptedAt: { type: DataTypes.DATE, allowNull: true },
    startedAt: { type: DataTypes.DATE, allowNull: true },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    approvedAt: { type: DataTypes.DATE, allowNull: true },
    releasedAt: { type: DataTypes.DATE, allowNull: true },
    cancelledAt: { type: DataTypes.DATE, allowNull: true },
    cancelReason: { type: DataTypes.TEXT, allowNull: true },
    autoReleaseAt: { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'Bookings', timestamps: true });

  Booking.STATUSES = STATUSES;

  Booking.associate = (models) => {
    Booking.belongsTo(models.Member, { foreignKey: 'hirerId', as: 'hirer' });
    Booking.belongsTo(models.ChefProfile, { foreignKey: 'chefId', as: 'chef' });
    Booking.belongsTo(models.ChefService, { foreignKey: 'serviceId', as: 'service' });
    Booking.hasMany(models.BookingPayment, { foreignKey: 'bookingId', as: 'payments' });
    Booking.hasOne(models.BookingReview, { foreignKey: 'bookingId', as: 'review' });
    Booking.hasMany(models.Dispute, { foreignKey: 'bookingId', as: 'disputes' });
  };

  return Booking;
};
