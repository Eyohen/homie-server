'use strict';

module.exports = (sequelize, DataTypes) => {
  const ChefProfile = sequelize.define('ChefProfile', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    memberId: { type: DataTypes.UUID, allowNull: false, unique: true, references: { model: 'Members', key: 'id' } },
    displayName: { type: DataTypes.STRING(150), allowNull: false },
    bio: { type: DataTypes.TEXT, allowNull: true },
    cuisines: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
    tags: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
    yearsExperience: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    eventsCooked: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    replyTime: { type: DataTypes.STRING(30), allowNull: true },
    area: { type: DataTypes.STRING(150), allowNull: true },
    lat: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
    lng: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
    coverUrl: { type: DataTypes.STRING(500), allowNull: true },
    portfolio: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    verificationStatus: {
      // registered -> pending (KYC submitted) -> verified (checks complete) -> approved (cleared to work). Also suspended / rejected.
      type: DataTypes.ENUM('unsubmitted', 'registered', 'pending', 'verified', 'approved', 'suspended', 'rejected'),
      allowNull: false,
      defaultValue: 'registered',
    },
    verificationData: { type: DataTypes.JSONB, allowNull: true },
    verificationNote: { type: DataTypes.TEXT, allowNull: true },
    verifiedAt: { type: DataTypes.DATE, allowNull: true },
    tier: { type: DataTypes.ENUM('standard', 'premium', 'elite'), allowNull: false, defaultValue: 'standard' },
    available: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ratingAvg: { type: DataTypes.DECIMAL(3, 2), allowNull: false, defaultValue: 0 },
    ratingCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    startingPrice: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    startingUnit: { type: DataTypes.STRING(20), allowNull: true },
  }, { tableName: 'ChefProfiles', timestamps: true });

  ChefProfile.associate = (models) => {
    ChefProfile.belongsTo(models.Member, { foreignKey: 'memberId', as: 'member' });
    ChefProfile.hasMany(models.ChefService, { foreignKey: 'chefId', as: 'services' });
    ChefProfile.hasMany(models.ChefBlockedDate, { foreignKey: 'chefId', as: 'blockedDates' });
    ChefProfile.hasOne(models.PayoutAccount, { foreignKey: 'chefId', as: 'payoutAccount' });
    ChefProfile.hasMany(models.Booking, { foreignKey: 'chefId', as: 'bookings' });
    ChefProfile.hasMany(models.BookingReview, { foreignKey: 'chefId', as: 'reviews' });
    ChefProfile.hasOne(models.ChefKyc, { foreignKey: 'chefId', as: 'kyc' });
  };

  return ChefProfile;
};
