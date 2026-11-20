'use strict';

module.exports = (sequelize, DataTypes) => {
  const BookingReview = sequelize.define('BookingReview', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    bookingId: { type: DataTypes.UUID, allowNull: false, unique: true, references: { model: 'Bookings', key: 'id' } },
    hirerId: { type: DataTypes.UUID, allowNull: false, references: { model: 'Members', key: 'id' } },
    chefId: { type: DataTypes.UUID, allowNull: false, references: { model: 'ChefProfiles', key: 'id' } },
    rating: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 5 } },
    comment: { type: DataTypes.TEXT, allowNull: true },
  }, { tableName: 'BookingReviews', timestamps: true });

  BookingReview.associate = (models) => {
    BookingReview.belongsTo(models.Booking, { foreignKey: 'bookingId', as: 'booking' });
    BookingReview.belongsTo(models.Member, { foreignKey: 'hirerId', as: 'hirer' });
    BookingReview.belongsTo(models.ChefProfile, { foreignKey: 'chefId', as: 'chef' });
  };

  return BookingReview;
};
