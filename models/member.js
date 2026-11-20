'use strict';

module.exports = (sequelize, DataTypes) => {
  const Member = sequelize.define('Member', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    phone: { type: DataTypes.STRING(30), allowNull: true, unique: true },
    email: { type: DataTypes.STRING(255), allowNull: true, unique: true, validate: { isEmail: true } },
    firstName: { type: DataTypes.STRING(100), allowNull: true },
    lastName: { type: DataTypes.STRING(100), allowNull: true },
    dateOfBirth: { type: DataTypes.DATEONLY, allowNull: true },
    emailVerifiedAt: { type: DataTypes.DATE, allowNull: true },
    kycStatus: { type: DataTypes.ENUM('registered', 'pending', 'verified', 'approved', 'suspended', 'rejected'), allowNull: false, defaultValue: 'registered' },
    idType: { type: DataTypes.STRING(30), allowNull: true },
    idLast4: { type: DataTypes.STRING(4), allowNull: true },
    idDocumentRef: { type: DataTypes.STRING(300), allowNull: true },
    idSubmittedAt: { type: DataTypes.DATE, allowNull: true },
    idVerifiedAt: { type: DataTypes.DATE, allowNull: true },
    kycNote: { type: DataTypes.TEXT, allowNull: true },
    avatarUrl: { type: DataTypes.STRING(500), allowNull: true },
    activeRole: { type: DataTypes.ENUM('hirer', 'chef'), allowNull: false, defaultValue: 'hirer' },
    isChef: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: { type: DataTypes.ENUM('active', 'suspended', 'deleted'), allowNull: false, defaultValue: 'active' },
    suspendedReason: { type: DataTypes.TEXT, allowNull: true },
    address: { type: DataTypes.TEXT, allowNull: true },
    lat: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
    lng: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
    pushToken: { type: DataTypes.STRING(255), allowNull: true },
    refreshTokenHash: { type: DataTypes.STRING(120), allowNull: true },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'Members', timestamps: true });

  Member.associate = (models) => {
    Member.hasOne(models.ChefProfile, { foreignKey: 'memberId', as: 'chefProfile' });
    Member.hasMany(models.Booking, { foreignKey: 'hirerId', as: 'bookings' });
    Member.hasMany(models.Favorite, { foreignKey: 'memberId', as: 'favorites' });
    Member.hasMany(models.AppNotification, { foreignKey: 'memberId', as: 'notifications' });
  };

  Member.prototype.fullName = function fullName() {
    return [this.firstName, this.lastName].filter(Boolean).join(' ') || 'Homie member';
  };

  return Member;
};
