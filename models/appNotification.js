'use strict';

module.exports = (sequelize, DataTypes) => {
  const AppNotification = sequelize.define('AppNotification', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    memberId: { type: DataTypes.UUID, allowNull: false, references: { model: 'Members', key: 'id' } },
    type: { type: DataTypes.STRING(40), allowNull: false },
    title: { type: DataTypes.STRING(160), allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: true },
    data: { type: DataTypes.JSONB, allowNull: true },
    readAt: { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'AppNotifications', timestamps: true });

  AppNotification.associate = (models) => {
    AppNotification.belongsTo(models.Member, { foreignKey: 'memberId', as: 'member' });
  };

  return AppNotification;
};
