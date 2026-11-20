'use strict';

module.exports = (sequelize, DataTypes) => {
  const PayoutAccount = sequelize.define('PayoutAccount', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    chefId: { type: DataTypes.UUID, allowNull: false, unique: true, references: { model: 'ChefProfiles', key: 'id' } },
    bankCode: { type: DataTypes.STRING(20), allowNull: false },
    bankName: { type: DataTypes.STRING(120), allowNull: true },
    accountNumber: { type: DataTypes.STRING(20), allowNull: false },
    accountName: { type: DataTypes.STRING(150), allowNull: true },
    recipientCode: { type: DataTypes.STRING(100), allowNull: true },
  }, { tableName: 'PayoutAccounts', timestamps: true });

  PayoutAccount.associate = (models) => {
    PayoutAccount.belongsTo(models.ChefProfile, { foreignKey: 'chefId', as: 'chef' });
  };

  return PayoutAccount;
};
