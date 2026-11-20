'use strict';

module.exports = (sequelize, DataTypes) => {
  const Favorite = sequelize.define('Favorite', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    memberId: { type: DataTypes.UUID, allowNull: false, references: { model: 'Members', key: 'id' } },
    chefId: { type: DataTypes.UUID, allowNull: false, references: { model: 'ChefProfiles', key: 'id' } },
  }, { tableName: 'Favorites', timestamps: true });

  Favorite.associate = (models) => {
    Favorite.belongsTo(models.Member, { foreignKey: 'memberId', as: 'member' });
    Favorite.belongsTo(models.ChefProfile, { foreignKey: 'chefId', as: 'chef' });
  };

  return Favorite;
};
