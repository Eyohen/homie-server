'use strict';

module.exports = (sequelize, DataTypes) => {
  const ChefService = sequelize.define('ChefService', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    chefId: { type: DataTypes.UUID, allowNull: false, references: { model: 'ChefProfiles', key: 'id' } },
    title: { type: DataTypes.STRING(150), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    price: { type: DataTypes.DECIMAL(15, 2), allowNull: false, validate: { min: 0 } },
    unit: { type: DataTypes.ENUM('dish', 'event', 'hour', 'order'), allowNull: false, defaultValue: 'event' },
    icon: { type: DataTypes.STRING(40), allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, { tableName: 'ChefServices', timestamps: true });

  ChefService.associate = (models) => {
    ChefService.belongsTo(models.ChefProfile, { foreignKey: 'chefId', as: 'chef' });
  };

  return ChefService;
};
