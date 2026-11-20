'use strict';

module.exports = (sequelize, DataTypes) => {
  const OtpCode = sequelize.define('OtpCode', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    target: { type: DataTypes.STRING(255), allowNull: false },
    channel: { type: DataTypes.ENUM('sms', 'email'), allowNull: false },
    codeHash: { type: DataTypes.STRING(120), allowNull: false },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    consumedAt: { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'OtpCodes', timestamps: true });

  return OtpCode;
};
