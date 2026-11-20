'use strict';

module.exports = (sequelize, DataTypes) => {
  const ChefBlockedDate = sequelize.define('ChefBlockedDate', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    chefId: { type: DataTypes.UUID, allowNull: false, references: { model: 'ChefProfiles', key: 'id' } },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    reason: { type: DataTypes.STRING(200), allowNull: true },
  }, { tableName: 'ChefBlockedDates', timestamps: true });

  ChefBlockedDate.associate = (models) => {
    ChefBlockedDate.belongsTo(models.ChefProfile, { foreignKey: 'chefId', as: 'chef' });
  };

  return ChefBlockedDate;
};
