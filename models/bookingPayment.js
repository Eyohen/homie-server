'use strict';

module.exports = (sequelize, DataTypes) => {
  const BookingPayment = sequelize.define('BookingPayment', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    bookingId: { type: DataTypes.UUID, allowNull: false, references: { model: 'Bookings', key: 'id' } },
    paystackReference: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    accessCode: { type: DataTypes.STRING(100), allowNull: true },
    authorizationUrl: { type: DataTypes.STRING(500), allowNull: true },
    amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    currency: { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'NGN' },
    channel: { type: DataTypes.STRING(30), allowNull: true },
    status: {
      type: DataTypes.ENUM('initialized', 'held', 'released', 'refund_pending', 'refunded', 'partially_refunded', 'failed'),
      allowNull: false,
      defaultValue: 'initialized',
    },
    paidAt: { type: DataTypes.DATE, allowNull: true },
    releasedAt: { type: DataTypes.DATE, allowNull: true },
    refundedAt: { type: DataTypes.DATE, allowNull: true },
    refundAmount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
    payoutStatus: {
      type: DataTypes.ENUM('none', 'pending', 'processing', 'paid', 'failed'),
      allowNull: false,
      defaultValue: 'none',
    },
    payoutAmount: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    payoutReference: { type: DataTypes.STRING(100), allowNull: true },
    payoutError: { type: DataTypes.TEXT, allowNull: true },
    gatewayResponse: { type: DataTypes.JSONB, allowNull: true },
  }, { tableName: 'BookingPayments', timestamps: true });

  BookingPayment.associate = (models) => {
    BookingPayment.belongsTo(models.Booking, { foreignKey: 'bookingId', as: 'booking' });
  };

  return BookingPayment;
};
